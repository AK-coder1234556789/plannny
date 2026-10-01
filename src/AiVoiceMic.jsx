import React, { useState, useRef, useEffect, useMemo } from 'react';
import { auth } from './firebase';
import useWakeWord, { wakeSupported } from './useWakeWord';
import VoiceSetup from './VoiceSetup';
import { DEFAULT_VOICE_CFG, buildWakeRegex } from './wakeUtil';

// Sends the signed-in user's Firebase token so the server can verify who is calling
async function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  try {
    const t = await auth.currentUser?.getIdToken();
    if (t) h.Authorization = 'Bearer ' + t;
  } catch {}
  return h;
}

// Short two-tone chime so the user knows the wake word was heard
let chimeCtx = null;
function playChime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    chimeCtx = chimeCtx || new AC();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const t = chimeCtx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = chimeCtx.createOscillator();
      const g = chimeCtx.createGain();
      const t0 = t + i * 0.11;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g);
      g.connect(chimeCtx.destination);
      o.start(t0);
      o.stop(t0 + 0.18);
    });
  } catch {}
}

// Reply voice chosen in "Voice setup"
const ttsPrefs = { voiceURI: '', rate: 1.05 };

// Optional Web Speech Synthesis for spoken confirmation
function speakFeedback(text) {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = ttsPrefs.rate || 1.05;
      if (ttsPrefs.voiceURI) {
        const v = window.speechSynthesis.getVoices().find((x) => x.voiceURI === ttsPrefs.voiceURI);
        if (v) utterance.voice = v;
      }
      utterance.pitch = 1.0;
      utterance.volume = 0.85;
      window.speechSynthesis.speak(utterance);
    } catch {
      // ignore
    }
  }
}

// Client-side rule-based command engine (guaranteed zero-downtime fallback)
function clientParseVoiceCommand(speechText, currentDate, labels = []) {
  const textLower = speechText.toLowerCase().trim();
  const today = currentDate || new Date().toISOString().slice(0, 10);
  const labelNames = labels.map((l) => (typeof l === 'string' ? l : l.name));

  // 1. Navigation
  if (textLower.includes('calendar') || textLower.includes('month view')) {
    return { action: 'navigate_view', feedback: 'Switched to Calendar view', payload: { view: 'cal' } };
  }
  if (textLower.includes('analysis') || textLower.includes('analytics') || textLower.includes('progress') || textLower.includes('stats')) {
    return { action: 'navigate_view', feedback: 'Switched to Analysis view', payload: { view: 'analysis' } };
  }
  if (textLower.includes('target') || textLower.includes('countdown') || textLower.includes('goals')) {
    if (!textLower.startsWith('add ') && !textLower.startsWith('new ') && !textLower.startsWith('pin ') && !textLower.startsWith('delete ') && !textLower.startsWith('remove ')) {
      return { action: 'navigate_view', feedback: 'Switched to Targets view', payload: { view: 'targets' } };
    }
  }
  if (textLower.includes('day view') || textLower.includes('daily view') || textLower.includes('today view') || textLower.includes('show today') || textLower.includes('go to today') || textLower === 'today') {
    return { action: 'navigate_view', feedback: 'Switched to Day view', payload: { view: 'day' } };
  }

  // Label navigation
  for (const lName of labelNames) {
    if (textLower === lName.toLowerCase() || textLower === `show ${lName.toLowerCase()}` || textLower === `go to ${lName.toLowerCase()}` || textLower === `${lName.toLowerCase()} label`) {
      return { action: 'navigate_view', feedback: `Showing label ${lName}`, payload: { view: 'label', labelName: lName } };
    }
  }

  // 2. Date Navigation
  if (textLower.includes('tomorrow') && !textLower.startsWith('add') && !textLower.startsWith('new')) {
    return { action: 'change_date', feedback: 'Navigated to Tomorrow', payload: { relativeDays: 1 } };
  }
  if (textLower.includes('yesterday') && !textLower.startsWith('add')) {
    return { action: 'change_date', feedback: 'Navigated to Yesterday', payload: { relativeDays: -1 } };
  }
  if (textLower.includes('next day')) {
    return { action: 'change_date', feedback: 'Navigated to Next Day', payload: { relativeDays: 1 } };
  }
  if (textLower.includes('previous day')) {
    return { action: 'change_date', feedback: 'Navigated to Previous Day', payload: { relativeDays: -1 } };
  }

  // 3. Settings / Appearance
  if (textLower.includes('wallpaper') || textLower.includes('theme') || textLower.includes('background')) {
    for (const w of ['aurora', 'dusk', 'grid', 'dots', 'plain', 'default']) {
      if (textLower.includes(w)) {
        return { action: 'update_settings', feedback: `Wallpaper updated to ${w}`, payload: { wallpaper: w } };
      }
    }
  }
  if (textLower.includes('stack layout') || textLower.includes('layout stack') || textLower.includes('switch to stack')) {
    return { action: 'update_settings', feedback: 'Layout set to Stack', payload: { layout: 'stack' } };
  }
  if (textLower.includes('column layout') || textLower.includes('layout columns') || textLower.includes('switch to columns') || textLower.includes('grid layout')) {
    return { action: 'update_settings', feedback: 'Layout set to Columns', payload: { layout: 'columns' } };
  }
  if (textLower.includes('sidebar') || textLower.includes('toggle sidebar')) {
    return { action: 'update_settings', feedback: 'Sidebar toggled', payload: { toggleSidebar: true } };
  }
  if (textLower.includes('open settings') || textLower.includes('show settings')) {
    return { action: 'open_settings', feedback: 'Opened Settings', payload: {} };
  }
  if (textLower.includes('close settings')) {
    return { action: 'close_settings', feedback: 'Closed Settings', payload: {} };
  }

  // 4. Label Removal
  if (textLower.startsWith('delete label ') || textLower.startsWith('remove label ')) {
    const lName = speechText.replace(/^(delete|remove)\s+label\s+/i, '').trim();
    if (lName) {
      return { action: 'delete_label', feedback: `Removed label "${lName}"`, payload: { labelName: lName } };
    }
  }

  // 5. Target Management
  if (textLower.startsWith('add target ') || textLower.startsWith('new target ')) {
    const targetBody = speechText.replace(/^(add|new)\s+target\s+/i, '').trim();
    let name = targetBody;
    let deadline = today;
    const deadlineMatch = targetBody.match(/(?:by|deadline|on)\s+([A-Za-z0-9\s,-]+)$/i);
    if (deadlineMatch) {
      name = targetBody.slice(0, deadlineMatch.index).trim();
      const rawDate = deadlineMatch[1].trim();
      if (rawDate.toLowerCase().includes('tomorrow')) {
        const d = new Date(today + 'T00:00');
        d.setDate(d.getDate() + 1);
        deadline = d.toISOString().slice(0, 10);
      } else if (rawDate.toLowerCase().includes('next week')) {
        const d = new Date(today + 'T00:00');
        d.setDate(d.getDate() + 7);
        deadline = d.toISOString().slice(0, 10);
      } else {
        const parsed = new Date(rawDate);
        if (!isNaN(parsed.getTime())) {
          deadline = parsed.toISOString().slice(0, 10);
        }
      }
    }
    return { action: 'add_target', feedback: `Added target "${name}" with deadline ${deadline}`, payload: { targetName: name, deadline, note: '' } };
  }
  if (textLower.startsWith('pin target ')) {
    const query = speechText.replace(/^pin\s+target\s+/i, '').trim();
    return { action: 'pin_target', feedback: `Pinned target "${query}"`, payload: { targetQuery: query } };
  }
  if (textLower.startsWith('delete target ') || textLower.startsWith('remove target ')) {
    const query = speechText.replace(/^(delete|remove)\s+target\s+/i, '').trim();
    return { action: 'delete_target', feedback: `Deleted target "${query}"`, payload: { targetQuery: query } };
  }

  // 6. Event Management
  if (textLower.startsWith('add event ') || textLower.startsWith('add test ') || textLower.startsWith('add revision ')) {
    let type = 'other';
    if (textLower.includes('test') || textLower.includes('exam')) type = 'test';
    else if (textLower.includes('revision') || textLower.includes('revise')) type = 'revision';
    else if (textLower.includes('deadline')) type = 'deadline';
    let title = speechText.replace(/^add\s+(event|test|revision)\s+/i, '').trim();
    let time = '';
    const timeMatch = title.match(/(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (timeMatch) {
      time = timeMatch[1].trim();
      title = title.replace(timeMatch[0], '').trim();
    }
    return { action: 'add_event', feedback: `Added ${type} "${title}"`, payload: { title, date: today, time, eventType: type } };
  }
  if (textLower.startsWith('delete event ') || textLower.startsWith('remove event ')) {
    const query = speechText.replace(/^(delete|remove)\s+event\s+/i, '').trim();
    return { action: 'delete_event', feedback: `Deleted event "${query}"`, payload: { eventQuery: query } };
  }

  // 7. Task Complete & Delete
  if (textLower.startsWith('mark ') && (textLower.endsWith(' done') || textLower.endsWith(' completed') || textLower.includes(' as done'))) {
    const query = speechText.replace(/^mark\s+/i, '').replace(/\s+(as\s+)?(done|completed)$/i, '').trim();
    return { action: 'complete_task', feedback: `Marked "${query}" as done!`, payload: { targetQuery: query } };
  }
  if (textLower.startsWith('delete task ') || textLower.startsWith('remove task ')) {
    const query = speechText.replace(/^(delete|remove)\s+task\s+/i, '').trim();
    return { action: 'delete_task', feedback: `Deleted task "${query}"`, payload: { targetQuery: query } };
  }

  // 8. Default: Add Task
  let section = 'lectures';
  if (textLower.includes('hw') || textLower.includes('homework') || textLower.includes('dpp') || textLower.includes('sheet') || textLower.includes('questions') || textLower.includes('exercise')) {
    section = 'hw';
  } else if (textLower.includes('doubt') || textLower.includes('concept') || textLower.includes('problem')) {
    section = 'doubts';
  }
  let date = today;
  if (textLower.includes('tomorrow')) {
    const d = new Date(today + 'T00:00');
    d.setDate(d.getDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  let labelName = null;
  for (const l of labelNames) {
    if (textLower.includes(l.toLowerCase())) {
      labelName = l;
      break;
    }
  }
  let cleanedText = speechText
    .replace(/^add\s+(task\s+)?/i, '')
    .replace(/^(to\s+)?(lectures|lecture|hw|homework|dpp|doubts|doubt)\s*[:,-]?\s*/i, '')
    .replace(/\s+(to|in)\s+(lectures|lecture|hw|homework|dpp|doubts|doubt)$/i, '')
    .trim();
  if (!cleanedText) cleanedText = speechText;

  const sectionName = section === 'hw' ? 'HW' : section === 'doubts' ? 'Doubts' : 'Lectures';
  return {
    action: 'add_task',
    feedback: `Added "${cleanedText}" to ${sectionName}${labelName ? ' [' + labelName + ']' : ''}`,
    payload: { section, text: cleanedText, date, labelName, type: 'task' },
  };
}

// Downsample audio Float32 buffer and produce standard 16kHz Mono 16-bit PCM WAV
function createWavBlobFromSamples(floatSamples, inputSampleRate = 44100, targetSampleRate = 16000) {
  if (!floatSamples || floatSamples.length === 0) return null;
  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(floatSamples.length / ratio));
  const downsampled = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetInput = 0;
  while (offsetResult < downsampled.length) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < floatSamples.length; i++) {
      accum += floatSamples[i];
      count++;
    }
    downsampled[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  const buffer = new ArrayBuffer(44 + downsampled.length * 2);
  const view = new DataView(buffer);
  // RIFF
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  view.setUint32(4, 36 + downsampled.length * 2, true);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
  // fmt
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  // data
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  view.setUint32(40, downsampled.length * 2, true);
  let offset = 44;
  for (let i = 0; i < downsampled.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, downsampled[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

export default function AiVoiceMic({
  currentDate,
  currentView,
  labels,
  onNavigateView,
  onDateChange,
  onAddTask,
  onCompleteTask,
  onDeleteTask,
  onAddTarget,
  onPinTarget,
  onDeleteTarget,
  onAddEvent,
  onDeleteEvent,
  onAddLabel,
  onDeleteLabel,
  onUpdateSettings,
  onToggleSettingsModal,
  onSignOut,
}) {
  const [listening, setListening] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState('');

  const [useDirectAudio, setUseDirectAudio] = useState(false);
  const [manualCmd, setManualCmd] = useState('');

  // Audio Device Selection
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    return localStorage.getItem('jee_selected_mic_id') || '';
  });

  // Real-time microphone audio & voice reception detection
  const [audioLevel, setAudioLevel] = useState(0);
  const [frequencies, setFrequencies] = useState([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  const [voiceDetected, setVoiceDetected] = useState(false);
  const [hasReceivedSound, setHasReceivedSound] = useState(false);
  const [silenceDuration, setSilenceDuration] = useState(0);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [sttStatus, setSttStatus] = useState('');

  // Voice setup: custom wake word, accent, reply voice (stored per device)
  const [voiceCfg, setVoiceCfg] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('jee_voice_setup') || '{}');
      return { ...DEFAULT_VOICE_CFG, ...saved, aliases: Array.isArray(saved.aliases) ? saved.aliases : DEFAULT_VOICE_CFG.aliases };
    } catch {
      return DEFAULT_VOICE_CFG;
    }
  });
  const [setupOpen, setSetupOpen] = useState(false);
  const wakeRegex = useMemo(() => buildWakeRegex(voiceCfg.phrase, voiceCfg.aliases), [voiceCfg.phrase, voiceCfg.aliases]);
  ttsPrefs.voiceURI = voiceCfg.voiceURI;
  ttsPrefs.rate = voiceCfg.rate;
  const wakeName = voiceCfg.phrase || DEFAULT_VOICE_CFG.phrase;

  // Hands-free wake word
  const [wakeEnabled, setWakeEnabled] = useState(() => {
    try { return wakeSupported() && localStorage.getItem('jee_wake_enabled') === '1'; } catch { return false; }
  });

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const activeStreamRef = useRef(null);
  const silenceCounterRef = useRef(0);

  // Auto-dismiss errors after 6 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(''), 6000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const feedbackTimerRef = useRef(null);

  // Raw PCM sample accumulator from Web Audio API (captures direct headset audio)
  const recordedSamplesRef = useRef([]);
  const scriptProcessorRef = useRef(null);
  const isListeningRef = useRef(false);
  const isTranscribingRef = useRef(false);
  const liveTranscribeTimerRef = useRef(null);
  const lastSrResultAtRef = useRef(0); // when browser speech last produced text
  const serverSttBlockedRef = useRef(false); // /api/transcribe-audio unreachable or rate limited
  const heardSpeechRef = useRef(false); // real speech heard in this recording
  const autoFinishRef = useRef(null); // always points at the latest handleDoneAndRun

  // Load and enumerate all available microphone devices
  const loadAudioDevices = async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      setAudioDevices(inputs);
    } catch (e) {
      console.warn('Could not enumerate audio devices:', e);
    }
  };

  useEffect(() => {
    loadAudioDevices();
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', loadAudioDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', loadAudioDevices);
      };
    }
  }, []);

  // Helper to obtain audio media stream using selected mic device
  const getAudioStream = async (deviceIdOverride) => {
    const targetDevId = deviceIdOverride !== undefined ? deviceIdOverride : selectedDeviceId;
    const constraints = {
      audio: targetDevId
        ? {
            deviceId: { exact: targetDevId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    loadAudioDevices();
    return stream;
  };

  // Change microphone input
  const handleDeviceChange = async (newDeviceId) => {
    setSelectedDeviceId(newDeviceId);
    localStorage.setItem('jee_selected_mic_id', newDeviceId);

    if (isTestingMic || listening) {
      try {
        const stream = await getAudioStream(newDeviceId);
        startAudioVisualizer(stream);
      } catch (err) {
        console.warn('Switch mic error:', err);
      }
    }
  };

  // Active live headset audio transcriber (sends captured audio snippets to Gemini for live text display)
  const triggerLiveTranscribe = () => {
    if (liveTranscribeTimerRef.current) return;
    liveTranscribeTimerRef.current = setTimeout(async () => {
      liveTranscribeTimerRef.current = null;
      if (isTranscribingRef.current || recordedSamplesRef.current.length < 8) return;
      if (serverSttBlockedRef.current) return;
      // Browser speech is already writing text: don't spend server quota
      if (Date.now() - lastSrResultAtRef.current < 4000) return;
      isTranscribingRef.current = true;
      try {
        let totalLength = 0;
        for (const arr of recordedSamplesRef.current) totalLength += arr.length;
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const arr of recordedSamplesRef.current) {
          merged.set(arr, offset);
          offset += arr.length;
        }

        const audioCtx = audioContextRef.current;
        const wavBlob = createWavBlobFromSamples(merged, audioCtx?.sampleRate || 44100, 16000);
        if (!wavBlob || wavBlob.size < 1200) return;

        const reader = new FileReader();
        const base64Promise = new Promise((resolve) => {
          reader.onloadend = () => resolve(reader.result?.toString().split(',')[1] || '');
        });
        reader.readAsDataURL(wavBlob);
        const b64 = await base64Promise;
        if (!b64) return;

        const res = await fetch('/api/transcribe-audio', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ audioBase64: b64, mimeType: 'audio/wav' }),
        });

        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.includes('application/json')) {
          const resData = await res.json();
          if (resData.success && resData.transcript) {
            setTranscript(resData.transcript);
            setManualCmd(resData.transcript);
            setSttStatus('');
          }
        } else if (res.status === 429) {
          serverSttBlockedRef.current = true;
          setTimeout(() => { serverSttBlockedRef.current = false; }, 30000);
          setSttStatus('Too many requests. Live text paused; it will still transcribe when you press Done.');
        } else if (res.status === 401) {
          setSttStatus('Please sign in again, then retry the mic.');
        } else {
          // 404 / HTML page = the voice server is not deployed here
          serverSttBlockedRef.current = true;
          setSttStatus('Voice server not reachable (needs /api on your host). Live text is off.');
        }
      } catch (err) {
        console.warn('Live transcribe check notice:', err);
      } finally {
        isTranscribingRef.current = false;
      }
    }, 3500);
  };

  // Real-time audio analyzer using Web Audio API + PCM sample capture
  const startAudioVisualizer = (stream) => {
    try {
      stopAudioVisualizer();
      activeStreamRef.current = stream;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      // ScriptProcessorNode to capture raw Float32 audio samples from the headset
      try {
        const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current = scriptNode;
        scriptNode.onaudioprocess = (e) => {
          if (!isListeningRef.current) return;
          const input = e.inputBuffer.getChannelData(0);
          recordedSamplesRef.current.push(new Float32Array(input));
          // If vocal audio is being received, trigger live active transcription
          if (silenceCounterRef.current < 20) {
            triggerLiveTranscribe();
          }
        };
        source.connect(scriptNode);
        scriptNode.connect(audioCtx.destination);
      } catch (scriptErr) {
        console.warn('ScriptProcessor setup note:', scriptErr);
      }

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      silenceCounterRef.current = 0;
      setSilenceDuration(0);
      setHasReceivedSound(false);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        const bars = [];
        const step = Math.max(1, Math.floor(bufferLength / 12));
        for (let i = 0; i < 12; i++) {
          const val = dataArray[i * step] || 0;
          bars.push(Math.round((val / 255) * 22) + 2);
          sum += val;
        }
        setFrequencies(bars);

        const avg = sum / bufferLength;
        const level = Math.min(100, Math.round((avg / 128) * 100));
        setAudioLevel(level);

        if (level > 4) {
          heardSpeechRef.current = true;
          setVoiceDetected(true);
          setHasReceivedSound(true);
          silenceCounterRef.current = 0;
          setSilenceDuration(0);
        } else {
          setVoiceDetected(false);
          silenceCounterRef.current += 1;
          // Wispr-style hands-free: ~1.8s of quiet after you spoke = run it
          if (heardSpeechRef.current && isListeningRef.current && silenceCounterRef.current === 110) {
            heardSpeechRef.current = false;
            if (autoFinishRef.current) autoFinishRef.current();
          }
          if (silenceCounterRef.current % 30 === 0) {
            setSilenceDuration((prev) => prev + 0.5);
          }
        }

        animFrameRef.current = requestAnimationFrame(updateMeter);
      };

      animFrameRef.current = requestAnimationFrame(updateMeter);
    } catch (e) {
      console.warn('Audio visualizer error:', e);
    }
  };

  const stopAudioVisualizer = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch {}
      scriptProcessorRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((track) => track.stop());
      activeStreamRef.current = null;
    }
    setAudioLevel(0);
    setVoiceDetected(false);
    setFrequencies([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  };

  // Direct Audio Recorder using browser microphone
  const startMediaRecorder = async () => {
    try {
      const stream = await getAudioStream();
      recordedSamplesRef.current = [];
      audioChunksRef.current = [];
      isListeningRef.current = true;
      startAudioVisualizer(stream);

      // Pick best supported MIME type
      let mimeType = 'audio/webm';
      if (typeof MediaRecorder.isTypeSupported === 'function') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        }
      }

      try {
        const mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };
        mediaRecorder.start(800);
      } catch (mrErr) {
        console.warn('MediaRecorder init note:', mrErr);
      }

      setListening(true);
      setError('');
      setUseDirectAudio(true);
    } catch (err) {
      console.error('Audio recorder error:', err);
      stopAudioVisualizer();
      setError('Microphone permission required. Please allow microphone access or select mic.');
      setListening(false);
    }
  };

  // Dedicated Microphone Input Check / Test
  const toggleTestMic = async () => {
    if (isTestingMic) {
      stopAudioVisualizer();
      setIsTestingMic(false);
      return;
    }

    try {
      setError('');
      if (listening) {
        isListeningRef.current = false;
        if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          try { mediaRecorderRef.current.stop(); } catch {}
        }
        setListening(false);
      }
      const stream = await getAudioStream();
      startAudioVisualizer(stream);
      setIsTestingMic(true);
    } catch (err) {
      console.error('Test mic error:', err);
      setError('Could not access selected mic: ' + (err.message || 'Permission denied'));
    }
  };

  // Setup Web Speech Recognition with continuous active transcription
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = voiceCfg.lang || navigator.language || 'en-US';

      recognition.onstart = () => {
        setError('');
      };

      recognition.onresult = (event) => {
        let full = '';
        for (let i = 0; i < event.results.length; i++) {
          full += event.results[i][0].transcript + ' ';
        }
        const text = full.trim();
        if (text) {
          lastSrResultAtRef.current = Date.now();
          setSttStatus('');
          setTranscript(text);
          setManualCmd(text);
        }
      };

      recognition.onerror = (event) => {
        console.warn('SpeechRecognition notice:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setError('Microphone access blocked. Please allow mic permissions in browser.');
        } else if (event.error === 'audio-capture') {
          setSttStatus("Browser speech can't open your mic. Set your headset as the default mic (Windows Sound settings and Chrome's mic setting).");
        } else if (event.error === 'network') {
          setSttStatus("Browser speech service unreachable (needs internet; Brave blocks it). Audio is still recorded and will be transcribed on Done.");
        } else if (event.error === 'language-not-supported') {
          setSttStatus('Browser speech does not support this language. Audio will be transcribed on Done.');
        }
      };

      recognition.onend = () => {
        // Auto-restart if user is still listening
        if (isListeningRef.current && recognitionRef.current) {
          try {
            recognitionRef.current.start();
          } catch {}
        }
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
      stopAudioVisualizer();
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
      if (liveTranscribeTimerRef.current) {
        clearTimeout(liveTranscribeTimerRef.current);
      }
    };
  }, [selectedDeviceId, voiceCfg.lang]);

  // Process recognized command with Gemini AI
  const executeVoiceCommand = async (textToProcess, audioBlob = null) => {
    if (!textToProcess && !audioBlob) return;
    setAnalyzing(true);
    setError('');

    try {
      let payload = {
        currentDate: currentDate || new Date().toISOString().slice(0, 10),
        currentView: currentView || 'day',
        existingLabels: labels.map((l) => l.name),
      };

      if (audioBlob) {
        const reader = new FileReader();
        const base64Promise = new Promise((resolve) => {
          reader.onloadend = () => resolve(reader.result?.toString().split(',')[1] || '');
        });
        reader.readAsDataURL(audioBlob);
        payload.audioBase64 = await base64Promise;
        payload.mimeType = audioBlob.type || 'audio/wav';
      } else {
        payload.speechText = textToProcess;
      }

      let commandData = null;
      let serverReached = false;

      // 1. Try server-side Gemini AI parser first
      try {
        const res = await fetch('/api/parse-voice-command', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify(payload),
        });

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const resData = await res.json();
          serverReached = true;
          if (resData && resData.success && resData.data) {
            commandData = resData.data;
          }
        } else {
          console.warn('Backend responded with non-JSON content:', res.status, contentType);
        }
      } catch (fetchErr) {
        console.warn('Network call to /api/parse-voice-command failed, using client fallback:', fetchErr);
      }

      // 2. If server didn't return data and we have text, run instant client-side parser
      if (!commandData && textToProcess) {
        commandData = clientParseVoiceCommand(textToProcess, currentDate, labels);
      }

      if (!commandData || commandData.action === 'feedback_only') {
        const msg = commandData?.feedback || (!serverReached && !textToProcess ? 'Could not reach the voice server, so I could not transcribe. Type the command below or use a quick button.' : null) || "Could not hear clear speech. Try speaking closer to mic or pick a quick command below.";
        setFeedback({ message: msg });
        speakFeedback(msg);
        return;
      }

      const { action, feedback: actionFeedback, payload: p } = commandData;

      // Execute matched action across app features
      switch (action) {
        case 'navigate_view': {
          if (p.view === 'label' && p.labelName) {
            const matched = labels.find((l) => l.name.toLowerCase() === p.labelName.toLowerCase());
            if (matched && onNavigateView) onNavigateView('label:' + matched.id);
            else if (onNavigateView) onNavigateView('day');
          } else if (onNavigateView) {
            onNavigateView(p.view || 'day');
          }
          break;
        }

        case 'change_date': {
          if (p.relativeDays !== undefined && onDateChange) {
            const d = new Date((currentDate || new Date().toISOString().slice(0, 10)) + 'T00:00');
            d.setDate(d.getDate() + p.relativeDays);
            onDateChange(d.toISOString().slice(0, 10));
          } else if (p.date && onDateChange) {
            onDateChange(p.date);
          }
          if (onNavigateView && currentView !== 'day') {
            onNavigateView('day');
          }
          break;
        }

        case 'add_task': {
          if (onAddTask) {
            await onAddTask(
              p.section || 'lectures',
              p.text || textToProcess,
              p.type || 'task',
              p.date || currentDate,
              p.labelName || null
            );
          }
          break;
        }

        case 'complete_task': {
          if (onCompleteTask) {
            await onCompleteTask(p.targetQuery || textToProcess);
          }
          break;
        }

        case 'delete_task': {
          if (onDeleteTask) {
            await onDeleteTask(p.targetQuery || textToProcess);
          }
          break;
        }

        case 'add_target': {
          if (onAddTarget) {
            await onAddTarget(p.targetName, p.deadline, p.note);
          }
          break;
        }

        case 'pin_target': {
          if (onPinTarget) {
            await onPinTarget(p.targetQuery);
          }
          break;
        }

        case 'delete_target': {
          if (onDeleteTarget) {
            await onDeleteTarget(p.targetQuery);
          }
          break;
        }

        case 'add_event': {
          if (onAddEvent) {
            await onAddEvent(p.title, p.date, p.time, p.eventType);
          }
          break;
        }

        case 'delete_event': {
          if (onDeleteEvent) {
            await onDeleteEvent(p.eventQuery);
          }
          break;
        }

        case 'add_label': {
          if (onAddLabel && p.labelName) {
            await onAddLabel(p.labelName);
          }
          break;
        }

        case 'delete_label': {
          if (onDeleteLabel && p.labelName) {
            await onDeleteLabel(p.labelName);
          }
          break;
        }

        case 'update_settings': {
          if (onUpdateSettings) {
            const patch = {};
            if (p.wallpaper) patch.wall = p.wallpaper;
            if (p.layout) patch.layout = p.layout;
            if (p.collapsed !== undefined) patch.collapsed = p.collapsed;
            if (p.accent) patch.accent = p.accent;
            if (p.toggleSidebar) patch.collapsed = '__toggle__';
            onUpdateSettings(patch);
          }
          break;
        }

        case 'open_settings': {
          if (onToggleSettingsModal) onToggleSettingsModal(true);
          break;
        }

        case 'close_settings': {
          if (onToggleSettingsModal) onToggleSettingsModal(false);
          break;
        }

        case 'sign_out': {
          if (onSignOut) onSignOut();
          break;
        }

        default: {
          if (onAddTask) {
            await onAddTask('lectures', textToProcess, 'task', currentDate, null);
          }
          break;
        }
      }

      const msg = actionFeedback || 'Action executed!';
      setFeedback({ message: msg });
      speakFeedback(msg);

      // Auto dismiss feedback banner
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = setTimeout(() => {
        setFeedback(null);
      }, 4500);

      setTranscript('');
    } catch (err) {
      console.error('Voice command execution failed:', err);
      setError(err?.message || 'Could not understand command');
    } finally {
      setAnalyzing(false);
    }
  };

  // Process stopping recording and submitting command
  const handleDoneAndRun = (overrideText = '') => {
    isListeningRef.current = false;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }

    // Merge Float32 samples from headset into pristine 16kHz Mono WAV
    let finalWavBlob = null;
    if (recordedSamplesRef.current && recordedSamplesRef.current.length > 0) {
      let totalLength = 0;
      for (const arr of recordedSamplesRef.current) totalLength += arr.length;
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const arr of recordedSamplesRef.current) {
        merged.set(arr, offset);
        offset += arr.length;
      }
      const audioCtx = audioContextRef.current;
      finalWavBlob = createWavBlobFromSamples(merged, audioCtx?.sampleRate || 44100, 16000);
    }

    stopAudioVisualizer();
    setListening(false);
    const cmd = ((typeof overrideText === 'string' && overrideText) || transcript || manualCmd || '').trim();
    executeVoiceCommand(cmd, finalWavBlob);
  };

  // Toggle microphone recording
  const toggleListening = async () => {
    setError('');

    // If currently analyzing, do nothing
    if (analyzing) return;

    // If currently listening, stop and process
    if (listening) {
      handleDoneAndRun();
      return;
    }

    // Start listening
    setTranscript('');
    setManualCmd('');
    setSttStatus('');
    heardSpeechRef.current = false;
    lastSrResultAtRef.current = 0;
    serverSttBlockedRef.current = false;

    // ALWAYS start MediaRecorder on the selected headset/microphone stream
    startMediaRecorder();

    // In parallel, start SpeechRecognition if available
    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.warn('SpeechRecognition parallel start notice:', err);
      }
    }
  };

  // Keep latest handlers reachable from the audio loop and the keyboard shortcut
  autoFinishRef.current = () => handleDoneAndRun();
  const toggleRef = useRef(null);
  toggleRef.current = toggleListening;

  // --- Wake word: say the chosen word (optionally followed by the command) ---
  const wakeHandlerRef = useRef(null);
  wakeHandlerRef.current = ({ command }) => {
    playChime();
    if (command) {
      // "<wake word>, add chemistry homework" -> run it right away
      setTranscript(command);
      setManualCmd(command);
      executeVoiceCommand(command);
    } else {
      // Just the wake word -> open the normal listening mode
      toggleListening();
    }
  };
  const wake = useWakeWord({
    enabled: wakeEnabled,
    paused: listening || analyzing || isTestingMic || setupOpen,
    lang: voiceCfg.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US'),
    wakeRegex,
    onWake: (payload) => wakeHandlerRef.current && wakeHandlerRef.current(payload),
  });

  const toggleWake = () => {
    if (!wakeSupported()) {
      setError(`Hands-free "${wakeName}" needs Chrome, Edge or Safari. Firefox does not support it.`);
      return;
    }
    const next = !wakeEnabled;
    setWakeEnabled(next);
    try { localStorage.setItem('jee_wake_enabled', next ? '1' : '0'); } catch {}
    if (next) {
      // Ask for mic permission now (inside the click) so it can listen later without a click
      try {
        navigator.mediaDevices?.getUserMedia({ audio: true })
          .then((st) => st.getTracks().forEach((t) => t.stop()))
          .catch(() => {});
      } catch {}
      playChime();
    }
  };

  // If the browser blocks the mic, turn the feature off and say why
  useEffect(() => {
    if (wake.state === 'blocked') {
      setWakeEnabled(false);
      try { localStorage.setItem('jee_wake_enabled', '0'); } catch {}
      setError(`Microphone blocked, so "${wakeName}" listening is off. Allow the mic in the address bar, then turn it on again.`);
    } else if (wake.state === 'nomic') {
      setError(`No microphone found for "${wakeName}" listening. Check your default mic.`);
    }
  }, [wake.state]);

  const wakeLabel =
    !wakeEnabled ? `Say "${wakeName}": off`
    : wake.state === 'offline' ? 'Wake word offline'
    : wake.state === 'paused' ? `${wakeName} is busy`
    : `Say "${wakeName}"`;

  const saveVoiceSetup = (cfg) => {
    setVoiceCfg(cfg);
    try { localStorage.setItem('jee_voice_setup', JSON.stringify(cfg)); } catch {}
    setSetupOpen(false);
    setFeedback({ message: `Saved. Say "${cfg.phrase}" to wake me.` });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 4000);
  };
  useEffect(() => {
    // Alt+V starts/stops the mic from anywhere on the page
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyV') {
        e.preventDefault();
        if (toggleRef.current) toggleRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="ai-voice-floating-container">
      {/* Floating Action / Result Banner popping up right above bottom-right button */}
      {listening && (
        <div className="ai-voice-live-hud">
          {/* Microphone Device Selection */}
          <div className="ai-mic-select-container">
            <span className="ai-mic-select-label">
              <i className="ti ti-microphone" /> Mic Input:
            </span>
            <select
              className="ai-mic-dropdown"
              value={selectedDeviceId}
              onChange={(e) => handleDeviceChange(e.target.value)}
              title="Select which microphone to record from"
            >
              <option value="">Default Microphone</option>
              {audioDevices.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `Microphone ${idx + 1}`}
                </option>
              ))}
            </select>
          </div>

          {/* Live Mic Reception Checker & Voice Indicator */}
          <div className="ai-mic-reception-card">
            <div className="ai-mic-status-row">
              <span
                className={`ai-mic-badge ${
                  voiceDetected
                    ? 'active'
                    : hasReceivedSound
                    ? 'active'
                    : silenceDuration > 2.5
                    ? 'silent'
                    : 'waiting'
                }`}
              >
                <i
                  className={`ti ${
                    voiceDetected
                      ? 'ti-microphone'
                      : silenceDuration > 2.5
                      ? 'ti-microphone-off'
                      : 'ti-waveform'
                  }`}
                />
                {voiceDetected
                  ? 'Voice Detected & Receiving'
                  : hasReceivedSound
                  ? 'Voice Audio Received'
                  : silenceDuration > 2.5
                  ? 'No Sound (Mic Muted/Silent)'
                  : 'Listening (speak now)…'}
              </span>
              <span className="ai-mic-vol-label">{audioLevel}% level</span>
            </div>

            {/* Dynamic visualizer bars jumping to real frequencies */}
            <div
              className="ai-waveform-container"
              title={`Live microphone input: ${audioLevel}%`}
            >
              {frequencies.map((h, idx) => (
                <div
                  key={idx}
                  className={`ai-wave-bar ${
                    voiceDetected ? 'speaking' : h > 4 ? '' : 'silent'
                  }`}
                  style={{ height: `${h}px` }}
                />
              ))}
            </div>

            {/* Live Volume VU bar */}
            <div
              className="ai-vu-bar-bg"
              title={`Live input volume: ${audioLevel}%`}
            >
              <div
                className="ai-vu-bar-fill"
                style={{
                  width: `${Math.max(audioLevel > 0 ? 6 : 0, audioLevel)}%`,
                }}
              />
            </div>

            {/* Helpful warning if mic volume stays 0% */}
            {silenceDuration > 3 && !hasReceivedSound && (
              <div className="ai-mic-silent-warning">
                ⚠️ <b>Mic is silent (0% input).</b> Check if your physical microphone is muted or switch mic above.
              </div>
            )}
          </div>

          {/* Real-Time Actively Written Transcription Box */}
          <div className="ai-active-transcription-card recording">
            <div className="ai-active-header">
              <span>
                <span className="ai-active-live-dot" />
                Actively Writing What Is Recorded
              </span>
              <span style={{ color: voiceDetected ? '#4ade80' : 'var(--muted)', fontWeight: 600 }}>
                {voiceDetected ? '🟢 Hearing Voice...' : '🎙️ Speak Now'}
              </span>
            </div>
            <div className={`ai-active-text ${!transcript && !manualCmd ? 'placeholder' : ''}`}>
              {transcript ||
                manualCmd ||
                (voiceDetected
                  ? (sttStatus || '🟢 Hearing your voice… text appears as it is recognised')
                  : 'Say anything: "Go to Calendar", "Add Optics to Lectures", "Mark optics done", "Wallpaper dusk"…')}
              <span className="ai-blinking-cursor">|</span>
            </div>
          </div>

          <div className="ai-live-actions">
            <button
              type="button"
              className="pill primary"
              style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600 }}
              onClick={handleDoneAndRun}
            >
              Done & Run
            </button>
            <button
              type="button"
              className="muted"
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => {
                if (recognitionRef.current) {
                  try { recognitionRef.current.stop(); } catch {}
                }
                if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                  mediaRecorderRef.current.stop();
                }
                stopAudioVisualizer();
                setListening(false);
                setTranscript('');
                setManualCmd('');
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="muted"
              style={{ fontSize: 11, padding: '4px 8px', marginLeft: 'auto' }}
              onClick={toggleTestMic}
              title="Test microphone input level"
            >
              <i className="ti ti-tool" style={{ marginRight: 3 }} /> Test Mic
            </button>
          </div>

          {/* Quick Tap Command Suggestions */}
          <div className="ai-quick-command-row">
            <span className="ai-quick-label">Tap to run:</span>
            <button
              type="button"
              className="ai-quick-chip"
              onClick={() => {
                setTranscript('Go to Calendar');
                setManualCmd('Go to Calendar');
                handleDoneAndRun('Go to Calendar');
              }}
            >
              📅 Calendar
            </button>
            <button
              type="button"
              className="ai-quick-chip"
              onClick={() => {
                setTranscript('Add Optics to Lectures');
                setManualCmd('Add Optics to Lectures');
                handleDoneAndRun('Add Optics to Lectures');
              }}
            >
              📚 Add Optics
            </button>
            <button
              type="button"
              className="ai-quick-chip"
              onClick={() => {
                setTranscript('Mark optics done');
                setManualCmd('Mark optics done');
                handleDoneAndRun('Mark optics done');
              }}
            >
              ✅ Mark Done
            </button>
            <button
              type="button"
              className="ai-quick-chip"
              onClick={() => {
                setTranscript('Wallpaper dusk');
                setManualCmd('Wallpaper dusk');
                handleDoneAndRun('Wallpaper dusk');
              }}
            >
              🎨 Dusk
            </button>
            <button
              type="button"
              className="ai-quick-chip"
              onClick={() => {
                setTranscript('View Targets');
                setManualCmd('View Targets');
                handleDoneAndRun('View Targets');
              }}
            >
              🎯 Targets
            </button>
          </div>

          {/* Real-time editable command form */}
          <form
            style={{ display: 'flex', gap: 6, marginTop: 2 }}
            onSubmit={(e) => {
              e.preventDefault();
              const cmd = (manualCmd || transcript).trim();
              if (cmd) {
                if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
                if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                  mediaRecorderRef.current.stop();
                }
                stopAudioVisualizer();
                setListening(false);
                executeVoiceCommand(cmd);
                setManualCmd('');
                setTranscript('');
              }
            }}
          >
            <input
              value={manualCmd || transcript}
              onChange={(e) => {
                setManualCmd(e.target.value);
                setTranscript(e.target.value);
              }}
              placeholder="Actively written words appear here (or type to edit)…"
              style={{ flex: 1, padding: '6px 9px', fontSize: 12, borderRadius: 8, background: '#1c1c20', color: '#fff', border: '1px solid #3f3f46' }}
            />
            <button type="submit" className="pill" style={{ padding: '6px 12px', fontSize: 11 }}>
              Execute
            </button>
          </form>
        </div>
      )}

      {/* Dedicated Mic Tester HUD */}
      {isTestingMic && !listening && (
        <div className="ai-voice-live-hud">
          <div className="ai-listening-indicator">
            <span
              className="ai-dot-pulse"
              style={{ background: voiceDetected ? '#22c55e' : '#eab308' }}
            />
            <b>Microphone Input Test & Device Selector</b>
          </div>

          {/* Microphone Selector Dropdown in Tester */}
          <div className="ai-mic-select-container">
            <span className="ai-mic-select-label">
              <i className="ti ti-microphone" /> Switch Mic:
            </span>
            <select
              className="ai-mic-dropdown"
              value={selectedDeviceId}
              onChange={(e) => handleDeviceChange(e.target.value)}
              title="Select which microphone to test"
            >
              <option value="">Default Microphone</option>
              {audioDevices.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `Microphone ${idx + 1}`}
                </option>
              ))}
            </select>
          </div>

          <div className="ai-mic-reception-card">
            <div className="ai-mic-status-row">
              <span
                className={`ai-mic-badge ${
                  voiceDetected
                    ? 'active'
                    : hasReceivedSound
                    ? 'active'
                    : silenceDuration > 2.5
                    ? 'silent'
                    : 'waiting'
                }`}
              >
                <i
                  className={`ti ${
                    voiceDetected
                      ? 'ti-microphone'
                      : silenceDuration > 2.5
                      ? 'ti-microphone-off'
                      : 'ti-waveform'
                  }`}
                />
                {voiceDetected
                  ? 'Voice Detected & Receiving'
                  : hasReceivedSound
                  ? 'Voice Audio Received'
                  : silenceDuration > 2.5
                  ? 'No Sound (Mic Muted/Silent)'
                  : 'Speak to test mic…'}
              </span>
              <span className="ai-mic-vol-label">{audioLevel}% level</span>
            </div>

            <div className="ai-waveform-container" title={`Live level: ${audioLevel}%`}>
              {frequencies.map((h, idx) => (
                <div
                  key={idx}
                  className={`ai-wave-bar ${
                    voiceDetected ? 'speaking' : h > 4 ? '' : 'silent'
                  }`}
                  style={{ height: `${h}px` }}
                />
              ))}
            </div>

            <div className="ai-vu-bar-bg" title={`Live input volume: ${audioLevel}%`}>
              <div
                className="ai-vu-bar-fill"
                style={{
                  width: `${Math.max(audioLevel > 0 ? 6 : 0, audioLevel)}%`,
                }}
              />
            </div>

            {silenceDuration > 3 && !hasReceivedSound && (
              <div className="ai-mic-silent-warning">
                ⚠️ <b>Mic is silent (0% input).</b> Check if your physical microphone is muted or switch to another mic above.
              </div>
            )}
          </div>

          <div className="ai-live-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: voiceDetected ? '#4ade80' : 'var(--muted)' }}>
              {voiceDetected ? '🟢 Receiving voice input!' : 'Speak into mic to test reception'}
            </span>
            <button
              type="button"
              className="pill"
              style={{ padding: '5px 12px', fontSize: 12 }}
              onClick={toggleTestMic}
            >
              Close Test
            </button>
          </div>
        </div>
      )}

      {/* Analyzing state banner */}
      {analyzing && (
        <div className="ai-voice-live-hud analyzing">
          <div className="ai-analyzing-content">
            <i className="ti ti-sparkles ai-spin" style={{ color: 'var(--accent)', fontSize: 20 }} />
            <span>Analyzing command with Gemini AI…</span>
          </div>
        </div>
      )}

      {/* Feedback Toast */}
      {feedback && (
        <div className="ai-voice-live-hud feedback">
          <div className="ai-feedback-header">
            <i className="ti ti-circle-check-filled" style={{ color: '#22c55e', fontSize: 20 }} />
            <span className="ai-feedback-text">{feedback.message}</span>
            <button
              type="button"
              className="x"
              style={{ marginLeft: 'auto', padding: 2 }}
              onClick={() => setFeedback(null)}
            >
              <i className="ti ti-x" />
            </button>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="ai-voice-live-hud error">
          <i className="ti ti-alert-triangle" style={{ fontSize: 18 }} />
          <span>{error}</span>
          <button type="button" className="x" style={{ marginLeft: 'auto' }} onClick={() => setError('')}>
            <i className="ti ti-x" />
          </button>
        </div>
      )}

      {/* Hands-free wake word switch + voice setup */}
      <div className="ai-wake-bar">
        <button
          type="button"
          className={`ai-wake-chip ${wakeEnabled ? 'on' : ''} ${wakeEnabled ? wake.state : ''}`}
          onClick={toggleWake}
          aria-pressed={wakeEnabled}
          title={wakeEnabled ? `Hands-free is on. Say "${wakeName}" then your command. Click to turn off.` : `Turn on hands-free: say "${wakeName}" to start talking`}
        >
          <span className="ai-wake-dot" />
          <span>{wakeLabel}</span>
        </button>
        <button
          type="button"
          className="ai-wake-gear"
          onClick={() => setSetupOpen(true)}
          title="Set up my voice and wake word"
          aria-label="Set up my voice and wake word"
        >
          <i className="ti ti-adjustments" />
        </button>
      </div>

      {setupOpen && (
        <VoiceSetup config={voiceCfg} onSave={saveVoiceSetup} onClose={() => setSetupOpen(false)} />
      )}

      {/* SUITABLY ENLARGED FLOATING MIC TOGGLE (NO TEXT) IN BOTTOM RIGHT */}
      <button
        type="button"
        id="ai-voice-fab"
        className={`ai-fab-mic-btn ${listening ? 'listening' : ''} ${analyzing ? 'analyzing' : ''} ${wakeEnabled && wake.state === 'listening' ? 'armed' : ''}`}
        title={listening ? 'Click to finish speaking' : analyzing ? 'AI is processing command…' : 'Toggle Voice Controller (Control the entire website with your voice)'}
        onClick={toggleListening}
        disabled={analyzing}
        aria-label="Voice Controller"
      >
        <div className="ai-fab-icon-wrap">
          {analyzing ? (
            <i className="ti ti-sparkles ai-spin" />
          ) : (
            <i className={listening ? 'ti ti-microphone' : 'ti ti-microphone'} />
          )}
        </div>

        {listening && (
          <span className="ai-fab-ripples">
            <span className="ai-ripple-1" />
            <span className="ai-ripple-2" />
          </span>
        )}
      </button>
    </div>
  );
}
