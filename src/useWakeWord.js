import { useCallback, useEffect, useRef, useState } from 'react';
import { buildWakeRegex, DEFAULT_VOICE_CFG } from './wakeUtil';

// ---------------------------------------------------------------------------
// Hands-free wake word ("Planny"), like "Hey Google".
//
// How it works:
//  1. While enabled, a continuous browser SpeechRecognition session listens in
//     the background and scans the text for the wake word.
//  2. When it hears "Planny":
//       - "Planny, add chemistry homework"    -> command runs straight away
//       - "Planny" (then a pause)             -> chime + normal listening mode
//  3. While a command is being listened to / processed, the wake listener
//     pauses (only one speech session can run at a time), then resumes.
//
// The wake word is chosen by the user in "Voice setup" (see VoiceSetup.jsx).
// ---------------------------------------------------------------------------

// Default wake word. The user can pick their own in "Voice setup"; the app passes
// the resulting regex in as `wakeRegex`.
export const WAKE_REGEX = buildWakeRegex(DEFAULT_VOICE_CFG.phrase, DEFAULT_VOICE_CFG.aliases);

const WORD_ONLY_WAIT_MS = 900; // "Planny" + pause  -> open listening mode
const WITH_COMMAND_WAIT_MS = 1400; // pause after the command -> run it
const START_DELAY_MS = 700; // let any other speech session release the mic first

export function wakeSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Text after the wake word, with leading punctuation removed
export function extractCommand(text, regex = WAKE_REGEX) {
  const m = regex.exec(text || '');
  if (!m) return '';
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim();
}

export default function useWakeWord({ enabled, paused, lang, onWake, wakeRegex }) {
  // off | listening | paused | offline | nomic | blocked | unsupported
  const [state, setState] = useState('off');

  const recRef = useRef(null);
  const enabledRef = useRef(enabled);
  const pausedRef = useRef(paused);
  const langRef = useRef(lang);
  const onWakeRef = useRef(onWake);
  const regexRef = useRef(wakeRegex || WAKE_REGEX);
  const suspendedRef = useRef(false); // true between "wake heard" and the command session starting
  const restartTimerRef = useRef(null);
  const resumeTimerRef = useRef(null);
  const pendingTimerRef = useRef(null);
  const backoffRef = useRef(400);

  enabledRef.current = enabled;
  pausedRef.current = paused;
  langRef.current = lang;
  onWakeRef.current = onWake;
  regexRef.current = wakeRegex || WAKE_REGEX;

  const hardStop = useCallback(() => {
    clearTimeout(restartTimerRef.current);
    clearTimeout(pendingTimerRef.current);
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.abort(); } catch {}
    }
  }, []);

  // Release the microphone/recognizer completely, then run cb
  const releaseThen = useCallback((cb) => {
    clearTimeout(pendingTimerRef.current);
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) { cb(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; cb(); } };
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = finish;
    try { rec.abort(); } catch { finish(); }
    setTimeout(finish, 500);
  }, []);

  const start = useCallback(() => {
    clearTimeout(restartTimerRef.current);
    if (!enabledRef.current || pausedRef.current || suspendedRef.current || recRef.current) return;

    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setState('unsupported'); return; }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = langRef.current || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

    let triggerIdx = -1; // index of the result that contained the wake word
    let lastCommand = '';
    let startedAt = 0;

    const fire = (command) => {
      suspendedRef.current = true;
      releaseThen(() => {
        try { onWakeRef.current && onWakeRef.current({ command }); } catch (e) { console.warn('wake handler error', e); }
        // Safety net: if the command session never started, resume wake listening
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = setTimeout(() => {
          suspendedRef.current = false;
          start();
        }, 8000);
      });
    };

    rec.onstart = () => {
      startedAt = Date.now();
      setState('listening');
    };

    rec.onresult = (e) => {
      // Ignore our own spoken feedback ("Task added") so it can't trigger us
      if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) return;

      if (triggerIdx < 0) {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (regexRef.current.test(e.results[i][0].transcript)) { triggerIdx = i; break; }
        }
        if (triggerIdx < 0) return;
      }

      let text = '';
      for (let i = triggerIdx; i < e.results.length; i++) text += e.results[i][0].transcript + ' ';
      lastCommand = extractCommand(text, regexRef.current);

      // Wait for the speaker to pause, then act
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = setTimeout(
        () => fire(lastCommand),
        lastCommand ? WITH_COMMAND_WAIT_MS : WORD_ONLY_WAIT_MS
      );
    };

    rec.onerror = (e) => {
      const err = e && e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        enabledRef.current = false; // stop the restart loop
        setState('blocked');
      } else if (err === 'network') {
        setState('offline');
      } else if (err === 'audio-capture') {
        setState('nomic');
      }
      // 'no-speech' and 'aborted' are normal; onend restarts us
    };

    rec.onend = () => {
      if (recRef.current !== rec) return;
      recRef.current = null;
      clearTimeout(pendingTimerRef.current);

      // Engine stopped while a wake word was pending: act on what we heard
      if (triggerIdx >= 0 && enabledRef.current && !pausedRef.current && !suspendedRef.current) {
        fire(lastCommand);
        return;
      }

      if (!enabledRef.current || pausedRef.current || suspendedRef.current) return;

      // Chrome ends sessions on its own every so often: restart, with backoff if it keeps failing fast
      if (startedAt && Date.now() - startedAt > 5000) backoffRef.current = 400;
      restartTimerRef.current = setTimeout(start, backoffRef.current);
      backoffRef.current = Math.min(backoffRef.current * 1.6, 5000);
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      recRef.current = null;
      restartTimerRef.current = setTimeout(start, 1500);
    }
  }, [releaseThen]);

  // Start / stop whenever enabled or paused changes
  useEffect(() => {
    clearTimeout(restartTimerRef.current);
    clearTimeout(resumeTimerRef.current);

    if (!enabled) {
      suspendedRef.current = false;
      hardStop();
      setState('off');
      return;
    }
    if (!wakeSupported()) {
      setState('unsupported');
      return;
    }
    if (paused) {
      hardStop();
      setState('paused');
      return;
    }
    suspendedRef.current = false;
    restartTimerRef.current = setTimeout(start, START_DELAY_MS);
    return () => clearTimeout(restartTimerRef.current);
  }, [enabled, paused, hardStop, start]);

  // Resume when the tab comes back to the foreground
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && enabledRef.current && !pausedRef.current) {
        restartTimerRef.current = setTimeout(start, 300);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [start]);

  // Clean up on unmount
  useEffect(() => () => {
    enabledRef.current = false;
    clearTimeout(resumeTimerRef.current);
    hardStop();
  }, [hardStop]);

  return { state, supported: wakeSupported() };
}
