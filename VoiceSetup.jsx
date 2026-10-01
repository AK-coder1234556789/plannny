import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auth } from './firebase';
import {
  DEFAULT_VOICE_CFG,
  aliasesFromHeard,
  buildWakeRegex,
  normalizePhrase,
  validatePhrase,
} from './wakeUtil';

const LANGS = [
  ['', 'Auto (browser language)'],
  ['en-IN', 'English (India)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['hi-IN', 'Hindi (India)'],
];

const TRAIN_ROUNDS = 3;
const MAX_TRIES = 7;

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

// Listen for ONE phrase. Resolves with the list of guesses (best first) or null if nothing was heard.
function heardOnce(lang) {
  return new Promise((resolve, reject) => {
    const SR = getSR();
    if (!SR) { reject(new Error('unsupported')); return; }
    const rec = new SR();
    rec.lang = lang || navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    let got = null;
    let settled = false;
    let hard = null;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(hard); fn(v); } };
    let audioStarted = false;
    const timer = setTimeout(() => { try { rec.abort(); } catch {} }, 6000);
    // Hard stop that does NOT rely on the browser firing onend (Edge can hang silently).
    // If the engine never even began capturing audio, report it as dead so we can use the server.
    hard = setTimeout(() => {
      try { rec.abort(); } catch {}
      if (!audioStarted && !got) done(reject, new Error('engine-dead'));
      else done(resolve, got);
    }, 8000);
    rec.onaudiostart = () => { audioStarted = true; };
    rec.onresult = (e) => {
      got = Array.from(e.results[0] || []).map((a) => a.transcript);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // onend resolves with null
      done(reject, new Error(e.error));
    };
    rec.onend = () => done(resolve, got);
    try { rec.start(); } catch (err) { done(reject, err); }
  });
}


// ---- Server fallback (works in Brave, and when the browser speech service is blocked/offline) ----
async function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  try {
    const t = await auth.currentUser?.getIdToken();
    if (t) h.Authorization = 'Bearer ' + t;
  } catch {}
  return h;
}

function encodeWav(float32, inRate, outRate = 16000) {
  const ratio = inRate / outRate;
  const len = Math.floor(float32.length / ratio);
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)] || 0));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// Record ~3.5 s from the mic, send to /api/transcribe-audio, return [transcript] or null
async function heardOnceViaServer() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error(e && e.name === 'NotFoundError' ? 'audio-capture' : 'not-allowed');
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  await new Promise((r) => setTimeout(r, 3500));
  try { proc.disconnect(); src.disconnect(); } catch {}
  stream.getTracks().forEach((t) => t.stop());
  const rate = ctx.sampleRate;
  try { await ctx.close(); } catch {}

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const blob = encodeWav(merged, rate);
  if (blob.size < 1200) return null;

  const b64 = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(fr.result?.toString().split(',')[1] || '');
    fr.readAsDataURL(blob);
  });
  let res;
  try {
    res = await fetch('/api/transcribe-audio', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ audioBase64: b64, mimeType: 'audio/wav' }),
    });
  } catch { throw new Error('server-down'); }
  if (res.status === 401) throw new Error('signin');
  if (res.status === 429) throw new Error('rate');
  if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) throw new Error('server-down');
  const data = await res.json();
  return data.success && data.transcript ? [data.transcript] : null;
}

// Try the browser speech service first. If it errors, is unresponsive, or hears nothing once
// (Edge does this silently when online speech is off), switch to the server for good.
let browserMisses = 0;
async function heardSmart(lang, onStatus) {
  if (browserMisses < 1) {
    try {
      const r = await heardOnce(lang);
      if (r && r.length) { browserMisses = 0; return r; }
      browserMisses++;
      onStatus && onStatus('Browser speech engine heard nothing. Switching to server recognition...');
    } catch (e) {
      if (!['network', 'unsupported', 'service-not-allowed', 'engine-dead'].includes(e.message)) throw e;
      browserMisses = 1;
      onStatus && onStatus('Browser speech engine is not responding. Switching to server recognition...');
    }
  }
  onStatus && onStatus('Listening for 3 seconds... say it now.');
  return heardOnceViaServer();
}

const ERR_TEXT = {
  'not-allowed': 'Microphone is blocked. Allow it in the address bar and try again.',
  'service-not-allowed': 'Microphone is blocked. Allow it in the address bar and try again.',
  'audio-capture': 'No microphone found. Check your default mic.',
  network: 'Speech service unreachable. Check your internet connection.',
  unsupported: 'This browser has no speech recognition. Use Chrome, Edge or Safari.',
  'server-down': 'Voice server not reachable. Make sure GEMINI_API_KEY is set in Vercel and the project was redeployed.',
  signin: 'Please sign in again, then retry.',
  rate: 'Too many requests. Wait a minute and try again.',
};

export default function VoiceSetup({ config, onSave, onClose }) {
  const [phrase, setPhrase] = useState(config.phrase);
  const [aliases, setAliases] = useState(config.aliases || []);
  const [lang, setLang] = useState(config.lang || '');
  const [voiceURI, setVoiceURI] = useState(config.voiceURI || '');
  const [rate, setRate] = useState(config.rate || 1.05);

  const [busy, setBusy] = useState(''); // '' | 'train' | 'test'
  const [round, setRound] = useState(0);
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState(''); // '' | ok | bad
  const [lastHeard, setLastHeard] = useState('');
  const [voices, setVoices] = useState([]);
  const runRef = useRef(0); // bumps on every start/stop so stale runs stop themselves

  const phraseError = useMemo(() => (phrase.trim() ? validatePhrase(phrase) : 'Type a wake word.'), [phrase]);
  const regex = useMemo(() => buildWakeRegex(phrase, aliases), [phrase, aliases]);

  // Load the device's voices (they arrive asynchronously in Chrome)
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  useEffect(() => () => { runRef.current++; try { window.speechSynthesis.cancel(); } catch {} }, []);

  const say = (text, kind = '') => { setMsg(text); setMsgKind(kind); };

  const changePhrase = (v) => {
    setPhrase(v);
    setAliases([]); // trained spellings belong to the old word
    say('');
    setLastHeard('');
  };

  // "Train my voice": say the wake word a few times; remember how the engine writes it for YOU
  const train = async () => {
    if (phraseError) { say(phraseError, 'bad'); return; }
    const runId = ++runRef.current;
    const stale = () => runRef.current !== runId;
    setBusy('train');
    setRound(0);
    const heard = [];
    let good = 0;
    let tries = 0;
    let exact = 0;
    const target = normalizePhrase(phrase);
    try {
      while (good < TRAIN_ROUNDS && tries < MAX_TRIES && !stale()) {
        tries++;
        say(`Say "${phrase.trim()}" now (${good + 1} of ${TRAIN_ROUNDS})`);
        const guesses = await heardSmart(lang, (t) => say(t));
        if (stale()) return;
        if (!guesses || !guesses.length) { say("Didn't catch that. Speak a little louder and try again."); continue; }
        // The engine often returns the wake word inside a longer guess. Keep only short guesses.
        good++;
        setRound(good);
        setLastHeard(guesses[0]);
        heard.push(...guesses);
        if (normalizePhrase(guesses[0]) === target) exact++;
      }
      if (stale()) return;
      const learned = aliasesFromHeard(phrase, heard);
      setAliases((prev) => Array.from(new Set([...prev, ...learned])));
      if (good < TRAIN_ROUNDS) {
        say('Could not hear you clearly enough. Check your mic and try again in a quieter spot.', 'bad');
      } else if (exact === TRAIN_ROUNDS) {
        say(`Perfect: it understood "${phrase.trim()}" every time.`, 'ok');
      } else if (learned.length) {
        say(`Done. It sometimes hears you differently, so I added ${learned.length} spelling${learned.length > 1 ? 's' : ''} below. Remove any that look wrong.`, 'ok');
      } else {
        say('Done, but it heard this word differently each time. Try a longer or more unusual wake word.', 'bad');
      }
    } catch (err) {
      if (!stale()) say(ERR_TEXT[err.message] || 'Could not use the microphone: ' + err.message, 'bad');
    } finally {
      if (!stale()) setBusy('');
    }
  };

  // Test: say it once and see if the wake word would fire
  const test = async () => {
    if (phraseError) { say(phraseError, 'bad'); return; }
    const runId = ++runRef.current;
    const stale = () => runRef.current !== runId;
    setBusy('test');
    say(`Say "${phrase.trim()}" now…`);
    try {
      const guesses = await heardSmart(lang, (t) => say(t));
      if (stale()) return;
      const text = guesses && guesses[0] ? guesses[0] : '';
      setLastHeard(text);
      if (!text) say("Didn't hear anything. Try again.", 'bad');
      else if (regex.test(text)) say(`It works. Heard: "${text}"`, 'ok');
      else say(`Heard "${text}", which does not match. Run "Train my voice" so it learns how you say it.`, 'bad');
    } catch (err) {
      if (!stale()) say(ERR_TEXT[err.message] || 'Could not use the microphone: ' + err.message, 'bad');
    } finally {
      if (!stale()) setBusy('');
    }
  };

  const stopBusy = () => { runRef.current++; setBusy(''); say(''); };

  const testVoice = () => {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(`Hi, I'm ${phrase.trim() || 'your planner'}. How can I help?`);
      const v = voices.find((x) => x.voiceURI === voiceURI);
      if (v) u.voice = v;
      u.rate = rate;
      window.speechSynthesis.speak(u);
    } catch {}
  };

  const save = () => {
    if (phraseError) { say(phraseError, 'bad'); return; }
    const clean = phrase.trim().replace(/\s+/g, ' ');
    onSave({ phrase: clean, aliases, lang, voiceURI, rate });
  };

  const reset = () => {
    setPhrase(DEFAULT_VOICE_CFG.phrase);
    setAliases(DEFAULT_VOICE_CFG.aliases);
    setLang(DEFAULT_VOICE_CFG.lang);
    setVoiceURI(DEFAULT_VOICE_CFG.voiceURI);
    setRate(DEFAULT_VOICE_CFG.rate);
    setLastHeard('');
    say('Reset to the default wake word.', 'ok');
  };

  const supported = !!getSR() || !!navigator.mediaDevices?.getUserMedia;

  return createPortal(
    <div className="modal voice-setup-modal" onClick={busy ? undefined : onClose}>
      <div className="card panel vs-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Voice setup">
        <div className="vs-head">
          <h2>Set up my voice</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close" disabled={!!busy}>
            <i className="ti ti-x" />
          </button>
        </div>

        {!supported && (
          <div className="vs-note bad">This browser has no speech recognition. Use Chrome, Edge or Safari.</div>
        )}

        {/* 1. Wake word */}
        <div className="vs-step">
          <div className="vs-step-title"><span className="vs-num">1</span> Your wake word</div>
          <input
            className="vs-input"
            value={phrase}
            maxLength={24}
            disabled={!!busy}
            onChange={(e) => changePhrase(e.target.value)}
            placeholder="e.g. Planny, Jarvis, Study buddy"
            aria-label="Wake word"
          />
          {phrase.trim() && phraseError ? (
            <div className="vs-hint bad">{phraseError}</div>
          ) : (
            <div className="vs-hint">Pick something distinctive that you will not say in normal talk. 2 to 4 syllables works best.</div>
          )}
        </div>

        {/* 2. Language */}
        <div className="vs-step">
          <div className="vs-step-title"><span className="vs-num">2</span> Language and accent</div>
          <select value={lang} disabled={!!busy} onChange={(e) => { setLang(e.target.value); setAliases([]); }} aria-label="Language and accent">
            {LANGS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <div className="vs-hint">Choosing the right accent is the biggest boost to accuracy.</div>
        </div>

        {/* 3. Train + test */}
        <div className="vs-step">
          <div className="vs-step-title"><span className="vs-num">3</span> Train it to your voice</div>
          <div className="vs-actions">
            {busy === 'train' ? (
              <button type="button" className="vs-btn" onClick={stopBusy}><i className="ti ti-player-stop" /> Stop</button>
            ) : (
              <button type="button" className="vs-btn primary" onClick={train} disabled={!!busy || !supported || !!phraseError}>
                <i className="ti ti-microphone" /> Train my voice
              </button>
            )}
            {busy === 'test' ? (
              <button type="button" className="vs-btn" onClick={stopBusy}><i className="ti ti-player-stop" /> Stop</button>
            ) : (
              <button type="button" className="vs-btn" onClick={test} disabled={!!busy || !supported || !!phraseError}>
                <i className="ti ti-checks" /> Test it
              </button>
            )}
          </div>

          {busy === 'train' && (
            <div className="vs-dots" aria-hidden="true">
              {Array.from({ length: TRAIN_ROUNDS }).map((_, i) => (
                <span key={i} className={i < round ? 'on' : ''} />
              ))}
            </div>
          )}

          {msg && (
            <div className={`vs-note ${msgKind}`} role="status">
              {busy && <i className="ti ti-loader-2 ai-spin" />} {msg}
            </div>
          )}
          {lastHeard && !busy && <div className="vs-hint">Last heard: “{lastHeard}”</div>}

          {aliases.length > 0 && (
            <div className="vs-aliases">
              <div className="vs-hint">Also counts as “{phrase.trim()}” (tap to remove):</div>
              <div className="vs-chiprow">
                {aliases.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="vs-chip"
                    disabled={!!busy}
                    onClick={() => setAliases(aliases.filter((x) => x !== a))}
                    title="Remove this spelling"
                  >
                    {a} <i className="ti ti-x" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 4. Reply voice */}
        <div className="vs-step">
          <div className="vs-step-title"><span className="vs-num">4</span> Voice that talks back</div>
          <select value={voiceURI} disabled={!!busy} onChange={(e) => setVoiceURI(e.target.value)} aria-label="Reply voice">
            <option value="">Browser default</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
            ))}
          </select>
          <label className="vs-rate">
            <span>Speed</span>
            <input type="range" min="0.7" max="1.4" step="0.05" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))} />
            <span>{rate.toFixed(2)}x</span>
          </label>
          <button type="button" className="vs-btn" onClick={testVoice} disabled={!!busy}>
            <i className="ti ti-volume" /> Hear this voice
          </button>
        </div>

        <div className="vs-foot">
          <button type="button" className="vs-link" onClick={reset} disabled={!!busy}>Reset to default</button>
          <button type="button" className="pill" onClick={save} disabled={!!busy || !!phraseError}>Save</button>
        </div>
        <div className="vs-hint">Saved on this device only. Your mic and accent differ per device.</div>
      </div>
    </div>,
    document.body
  );
}
