import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';

// Shared by server.ts (local / self-hosted) and api/*.ts (Vercel functions).
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.1-flash-lite,gemini-2.5-flash').split(',').map((m) => m.trim()).filter(Boolean);

export const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');
  return new GoogleGenAI({ apiKey });
};

function firebaseApiKey(): string {
  if (process.env.VITE_FIREBASE_API_KEY) return process.env.VITE_FIREBASE_API_KEY;
  try {
    const p = path.resolve(process.cwd(), 'firebase-applet-config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).apiKey || '';
  } catch {
    return '';
  }
}

// Verify the Firebase ID token and rate-limit per user (30 requests / minute).
const hits = new Map<string, number[]>();
export async function verifyUser(authHeader: string | undefined): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const token = (authHeader || '').startsWith('Bearer ') ? (authHeader as string).slice(7) : '';
    if (!token) return { ok: false, status: 401, error: 'Sign in required' };
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return { ok: false, status: 401, error: 'Invalid or expired sign-in' };
    const data: any = await r.json();
    const uid = data?.users?.[0]?.localId;
    if (!uid) return { ok: false, status: 401, error: 'Invalid sign-in' };
    const now = Date.now();
    const recent = (hits.get(uid) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 30) return { ok: false, status: 429, error: 'Too many requests. Wait a minute and try again.' };
    recent.push(now);
    hits.set(uid, recent);
    return { ok: true };
  } catch {
    return { ok: false, status: 500, error: 'Could not verify sign-in' };
  }
}

// Rule-based fallback parser for high-demand spikes or offline situations
function ruleBasedParseTask(speechText: string, currentDate: string, existingLabels?: string[]) {
  const textLower = speechText.toLowerCase();
  const today = currentDate || new Date().toISOString().slice(0, 10);

  // Section determination
  let section: 'lectures' | 'hw' | 'doubts' = 'lectures';
  if (textLower.includes('hw') || textLower.includes('homework') || textLower.includes('dpp') || textLower.includes('sheet') || textLower.includes('questions') || textLower.includes('exercise') || textLower.includes('assignment')) {
    section = 'hw';
  } else if (textLower.includes('doubt') || textLower.includes('ask') || textLower.includes('clarify') || textLower.includes('query')) {
    section = 'doubts';
  } else if (textLower.includes('lecture') || textLower.includes('class') || textLower.includes('video') || textLower.includes('theory')) {
    section = 'lectures';
  }

  // Date determination
  let targetDate = today;
  const d = new Date(today + 'T00:00');
  if (textLower.includes('tomorrow')) {
    d.setDate(d.getDate() + 1);
    targetDate = d.toISOString().slice(0, 10);
  } else if (textLower.includes('day after tomorrow')) {
    d.setDate(d.getDate() + 2);
    targetDate = d.toISOString().slice(0, 10);
  } else if (textLower.includes('yesterday')) {
    d.setDate(d.getDate() - 1);
    targetDate = d.toISOString().slice(0, 10);
  }

  // Subject label matching
  let matchedLabel: string | null = null;
  const availableLabels = existingLabels && existingLabels.length ? existingLabels : ['Physics', 'Chemistry', 'Maths'];
  for (const label of availableLabels) {
    if (textLower.includes(label.toLowerCase())) {
      matchedLabel = label;
      break;
    }
  }
  if (!matchedLabel) {
    if (textLower.includes('optics') || textLower.includes('mechanics') || textLower.includes('hcv') || textLower.includes('verma') || textLower.includes('rotational') || textLower.includes('electrostatics')) {
      matchedLabel = 'Physics';
    } else if (textLower.includes('organic') || textLower.includes('inorganic') || textLower.includes('isomerism') || textLower.includes('chouhan') || textLower.includes('coordination')) {
      matchedLabel = 'Chemistry';
    } else if (textLower.includes('calculus') || textLower.includes('integration') || textLower.includes('cengage') || textLower.includes('algebra') || textLower.includes('matrix')) {
      matchedLabel = 'Maths';
    }
  }

  // Type: task vs note
  const type = textLower.includes('note down') || textLower.includes('as a note') || textLower.startsWith('note ') ? 'note' : 'task';

  // Clean title
  let cleaned = speechText
    .replace(/^add\s+/i, '')
    .replace(/^please add\s+/i, '')
    .replace(/^note down\s+/i, '')
    .replace(/^note\s+/i, '')
    .replace(/\s+to\s+(lectures?|hw|homework|doubts?)\b.*$/i, '')
    .replace(/\s+in\s+(lectures?|hw|homework|doubts?)\b.*$/i, '')
    .replace(/\s+for\s+(today|tomorrow|yesterday)\b/i, '')
    .replace(/\s+with\s+(physics|chemistry|maths)\s+label\b/i, '')
    .trim();

  if (!cleaned) {
    cleaned = speechText;
  }
  // Capitalize first letter of each word
  cleaned = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());

  const sectionName = section === 'lectures' ? 'Lectures' : section === 'hw' ? 'HW' : 'Doubts';
  const dateName = targetDate === today ? 'today' : targetDate;

  return {
    section,
    text: cleaned,
    date: targetDate,
    labelName: matchedLabel,
    type,
    transcription: speechText,
    feedback: `Added "${cleaned}" to ${sectionName} for ${dateName}!`,
  };
}

// Comprehensive rule-based command parser for offline or instant command execution
function ruleBasedParseCommand(speechText: string, currentDate: string, existingLabels?: string[]) {
  const textLower = speechText.toLowerCase().trim();
  const today = currentDate || new Date().toISOString().slice(0, 10);
  const labels = existingLabels || ['Physics', 'Chemistry', 'Maths'];

  // 1. Navigation Commands
  if (textLower.includes('go to calendar') || textLower.includes('open calendar') || textLower.includes('show calendar') || textLower === 'calendar') {
    return {
      action: 'navigate_view',
      feedback: 'Opening Calendar view',
      payload: { view: 'calendar' },
      transcription: speechText,
    };
  }
  if (textLower.includes('go to analysis') || textLower.includes('open analysis') || textLower.includes('show analysis') || textLower.includes('show stats') || textLower.includes('my progress') || textLower === 'analysis') {
    return {
      action: 'navigate_view',
      feedback: 'Opening Analysis view',
      payload: { view: 'analysis' },
      transcription: speechText,
    };
  }
  if (textLower.includes('go to targets') || textLower.includes('open targets') || textLower.includes('show targets') || textLower === 'targets') {
    return {
      action: 'navigate_view',
      feedback: 'Opening Targets view',
      payload: { view: 'targets' },
      transcription: speechText,
    };
  }
  if (textLower.includes('go to day') || textLower.includes('open day') || textLower.includes('show day') || textLower.includes('day view') || textLower.includes('daily plan') || textLower === 'day') {
    return {
      action: 'navigate_view',
      feedback: 'Opening Day view',
      payload: { view: 'day' },
      transcription: speechText,
    };
  }

  // Label navigation
  for (const label of labels) {
    if (textLower.includes(`show ${label.toLowerCase()}`) || textLower.includes(`open ${label.toLowerCase()}`) || textLower.includes(`filter by ${label.toLowerCase()}`) || textLower.includes(`${label.toLowerCase()} label`)) {
      return {
        action: 'navigate_view',
        feedback: `Showing tasks for ${label}`,
        payload: { view: 'label', labelName: label },
        transcription: speechText,
      };
    }
  }

  // 2. Date Navigation
  if (textLower.includes('tomorrow') && (textLower.includes('go to') || textLower.includes('show') || textLower.includes('switch to') || textLower.startsWith('next day'))) {
    return {
      action: 'change_date',
      feedback: 'Switched to Tomorrow',
      payload: { relativeDays: 1 },
      transcription: speechText,
    };
  }
  if (textLower.includes('yesterday') && (textLower.includes('go to') || textLower.includes('show') || textLower.includes('switch to') || textLower.startsWith('previous day'))) {
    return {
      action: 'change_date',
      feedback: 'Switched to Yesterday',
      payload: { relativeDays: -1 },
      transcription: speechText,
    };
  }
  if (textLower === 'go to today' || textLower === 'show today' || textLower === 'today' || textLower === 'reset date') {
    return {
      action: 'change_date',
      feedback: 'Switched to Today',
      payload: { relativeDays: 0, date: today },
      transcription: speechText,
    };
  }

  // 3. Settings & Appearance
  if (textLower.includes('wallpaper')) {
    const wallMatch = ['aurora', 'dusk', 'grid', 'dots', 'rings', 'lines', 'plain'].find((w) => textLower.includes(w));
    if (wallMatch) {
      return {
        action: 'update_settings',
        feedback: `Changed wallpaper to ${wallMatch}`,
        payload: { wallpaper: wallMatch },
        transcription: speechText,
      };
    }
  }
  if (textLower.includes('layout to stack') || textLower.includes('stacked layout') || textLower.includes('switch to stack')) {
    return {
      action: 'update_settings',
      feedback: 'Switched layout to Stacked',
      payload: { layout: 'stack' },
      transcription: speechText,
    };
  }
  if (textLower.includes('layout to column') || textLower.includes('columns layout') || textLower.includes('switch to columns')) {
    return {
      action: 'update_settings',
      feedback: 'Switched layout to Columns',
      payload: { layout: 'columns' },
      transcription: speechText,
    };
  }
  if (textLower.includes('toggle sidebar') || textLower.includes('collapse sidebar') || textLower.includes('minimize sidebar') || textLower.includes('expand sidebar')) {
    return {
      action: 'update_settings',
      feedback: 'Toggled sidebar width',
      payload: { toggleSidebar: true },
      transcription: speechText,
    };
  }
  if (textLower.includes('accent to') || textLower.includes('color to')) {
    const colorMap: Record<string, string> = {
      orange: '#f97316',
      blue: '#3b82f6',
      purple: '#a855f7',
      red: '#ef4444',
      green: '#22c55e',
      emerald: '#10b981',
      cyan: '#06b6d4',
      yellow: '#eab308',
      pink: '#ec4899',
    };
    for (const [name, hex] of Object.entries(colorMap)) {
      if (textLower.includes(name)) {
        return {
          action: 'update_settings',
          feedback: `Changed accent color to ${name}`,
          payload: { accent: hex },
          transcription: speechText,
        };
      }
    }
  }
  if (textLower.includes('open settings') || textLower.includes('show settings')) {
    return {
      action: 'open_settings',
      feedback: 'Opened Settings',
      payload: {},
      transcription: speechText,
    };
  }
  if (textLower.includes('close settings') || textLower.includes('hide settings')) {
    return {
      action: 'close_settings',
      feedback: 'Closed Settings',
      payload: {},
      transcription: speechText,
    };
  }
  if (textLower === 'sign out' || textLower === 'log out' || textLower.includes('sign me out')) {
    return {
      action: 'sign_out',
      feedback: 'Signing out...',
      payload: {},
      transcription: speechText,
    };
  }

  // 4. Label Management: Add / Remove
  if (textLower.startsWith('add label ') || textLower.startsWith('create label ') || textLower.startsWith('new label ')) {
    const labelName = speechText.replace(/^(add|create|new)\s+label\s+/i, '').trim();
    if (labelName) {
      const cleanLabel = labelName.replace(/\b\w/g, (c) => c.toUpperCase());
      return {
        action: 'add_label',
        feedback: `Created new label "${cleanLabel}"`,
        payload: { labelName: cleanLabel },
        transcription: speechText,
      };
    }
  }
  if (textLower.startsWith('delete label ') || textLower.startsWith('remove label ')) {
    const labelName = speechText.replace(/^(delete|remove)\s+label\s+/i, '').trim();
    if (labelName) {
      return {
        action: 'delete_label',
        feedback: `Removed label "${labelName}"`,
        payload: { labelName },
        transcription: speechText,
      };
    }
  }

  // 5. Target Management: Add / Pin / Delete
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
    return {
      action: 'add_target',
      feedback: `Added target "${name}" with deadline ${deadline}!`,
      payload: { targetName: name, deadline, note: '' },
      transcription: speechText,
    };
  }
  if (textLower.startsWith('pin target ')) {
    const query = speechText.replace(/^pin\s+target\s+/i, '').trim();
    return {
      action: 'pin_target',
      feedback: `Pinned target "${query}" to countdown`,
      payload: { targetQuery: query },
      transcription: speechText,
    };
  }
  if (textLower.startsWith('delete target ') || textLower.startsWith('remove target ')) {
    const query = speechText.replace(/^(delete|remove)\s+target\s+/i, '').trim();
    return {
      action: 'delete_target',
      feedback: `Deleted target "${query}"`,
      payload: { targetQuery: query },
      transcription: speechText,
    };
  }

  // 6. Event Management: Add / Delete
  if (textLower.startsWith('add event ') || textLower.startsWith('add test ') || textLower.startsWith('add revision ')) {
    let type: 'test' | 'revision' | 'deadline' | 'other' = 'other';
    if (textLower.includes('test') || textLower.includes('exam') || textLower.includes('mock')) type = 'test';
    else if (textLower.includes('revision') || textLower.includes('revise')) type = 'revision';
    else if (textLower.includes('deadline') || textLower.includes('due')) type = 'deadline';

    let title = speechText.replace(/^add\s+(event|test|revision)\s+/i, '').trim();
    let time = '';
    const timeMatch = title.match(/(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (timeMatch) {
      time = timeMatch[1].trim();
      title = title.replace(timeMatch[0], '').trim();
    }
    return {
      action: 'add_event',
      feedback: `Added ${type} event "${title}"${time ? ' at ' + time : ''}!`,
      payload: { title, date: today, time, type },
      transcription: speechText,
    };
  }
  if (textLower.startsWith('delete event ') || textLower.startsWith('remove event ')) {
    const query = speechText.replace(/^(delete|remove)\s+event\s+/i, '').trim();
    return {
      action: 'delete_event',
      feedback: `Deleted event "${query}"`,
      payload: { eventQuery: query },
      transcription: speechText,
    };
  }

  // 7. Task Complete & Delete
  if (textLower.startsWith('mark ') && (textLower.endsWith(' done') || textLower.endsWith(' completed') || textLower.includes(' as done') || textLower.includes(' as completed'))) {
    const query = speechText
      .replace(/^mark\s+/i, '')
      .replace(/\s+(as\s+)?(done|completed)$/i, '')
      .trim();
    return {
      action: 'complete_task',
      feedback: `Marked "${query}" as completed!`,
      payload: { targetQuery: query },
      transcription: speechText,
    };
  }
  if (textLower.startsWith('delete task ') || textLower.startsWith('remove task ')) {
    const query = speechText.replace(/^(delete|remove)\s+task\s+/i, '').trim();
    return {
      action: 'delete_task',
      feedback: `Deleted task "${query}"`,
      payload: { targetQuery: query },
      transcription: speechText,
    };
  }

  // 8. Default: Add Task
  const taskData = ruleBasedParseTask(speechText, today, existingLabels);
  return {
    action: 'add_task',
    feedback: taskData.feedback,
    payload: {
      section: taskData.section,
      text: taskData.text,
      date: taskData.date,
      labelName: taskData.labelName,
      type: taskData.type,
    },
    transcription: speechText,
  };
}

export async function transcribeAudio(req: any, res: any) {
  try {
    const { audioBase64, mimeType } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'No audioBase64 provided' });
    }

    const ai = getAiClient();
    const audioPart = {
      inlineData: {
        mimeType: mimeType || 'audio/wav',
        data: audioBase64,
      },
    };

    const models = MODELS;
    let transcribed = '';

    for (const model of models) {
      try {
        const transRes = await ai.models.generateContent({
          model,
          contents: [
            audioPart,
            'Transcribe all spoken words from this audio clip verbatim. If the audio is silence or background noise with no discernable words, return empty string. Return ONLY the transcribed text.',
          ],
        });
        const text = transRes.text?.trim().replace(/^["']|["']$/g, '') || '';
        if (text && !text.toUpperCase().includes('NO_SPEECH') && !text.toUpperCase().includes('SILENCE')) {
          transcribed = text;
          break;
        }
      } catch (err: any) {
        console.warn(`[AI Server] /api/transcribe-audio with ${model} failed:`, err?.message || err);
      }
    }

    return res.json({ success: Boolean(transcribed), transcript: transcribed });
  } catch (err: any) {
    console.error('Error in /api/transcribe-audio:', err);
    return res.status(500).json({ error: err?.message || 'Failed to transcribe audio' });
  }
}

export async function parseVoiceCommand(req: any, res: any) {
  try {
    const { speechText, audioBase64, mimeType, currentDate, existingLabels, currentView } = req.body;

    const today = currentDate || new Date().toISOString().slice(0, 10);
    const dayOfWeek = new Date(today + 'T00:00').toLocaleDateString('en-US', { weekday: 'long' });

    let recognizedText = speechText ? speechText.trim() : '';

    // If audioBase64 was uploaded without speechText, transcribe it first
    if (!recognizedText && audioBase64) {
      console.log('[AI Server] Audio received, transcribing audio...');
      try {
        const ai = getAiClient();
        const audioPart = {
          inlineData: {
            mimeType: mimeType || 'audio/wav',
            data: audioBase64,
          },
        };

        const transcribeModels = MODELS;
        for (const m of transcribeModels) {
          try {
            const transRes = await ai.models.generateContent({
              model: m,
              contents: [
                audioPart,
                'Transcribe all words spoken by the student in this audio clip verbatim. Output only the plain transcribed words.',
              ],
            });
            const textOut = transRes.text?.trim() || '';
            if (textOut && !textOut.toUpperCase().includes('NO_SPEECH') && !textOut.toUpperCase().includes('SILENCE')) {
              recognizedText = textOut.replace(/^["']|["']$/g, '').trim();
              console.log(`[AI Server] Audio transcribed successfully by ${m}: "${recognizedText}"`);
              break;
            }
          } catch (e: any) {
            console.warn(`[AI Server] Transcription attempt with ${m} failed:`, e?.message || e);
          }
        }
      } catch (err: any) {
        console.warn('[AI Server] Audio transcription setup failed:', err?.message || err);
      }
    }

    // If no text could be recognized at all, gracefully inform the student instead of crashing
    if (!recognizedText && !speechText) {
      return res.json({
        success: true,
        data: {
          action: 'feedback_only',
          feedback: "Could not hear clear speech from your mic. Please speak a little louder or pick a quick command below.",
          transcription: '',
          payload: {},
        },
      });
    }

    const systemInstruction = `You are an expert AI voice assistant for a JEE (Joint Entrance Examination) student study planner web application.
The user speaks voice commands to control ANY function or feature of the entire website.
Context:
- Today's date: ${today} (${dayOfWeek}).
- Available labels: ${JSON.stringify(existingLabels || ['Physics', 'Chemistry', 'Maths'])}.
- Current view: ${currentView || 'day'}.

Identify user intent and return one of the following structured actions:
1. 'navigate_view': user wants to view a page (payload: { view: 'day'|'calendar'|'analysis'|'targets'|'label', labelName?: string }).
2. 'change_date': user wants to change day (payload: { relativeDays?: number, date?: string }).
3. 'add_task': user wants to add a task/note to lectures, hw, or doubts (payload: { section: 'lectures'|'hw'|'doubts', text: string, date: string, labelName?: string, type: 'task'|'note' }).
4. 'complete_task': user says marked done / completed (payload: { targetQuery: string }).
5. 'delete_task': user says delete task / remove task (payload: { targetQuery: string }).
6. 'add_target': user wants to set a target (payload: { targetName: string, deadline: string, note?: string }).
7. 'pin_target': user wants to pin target to countdown card (payload: { targetQuery: string }).
8. 'delete_target': user wants to delete target (payload: { targetQuery: string }).
9. 'add_event': user wants to add calendar event/test/mock/revision (payload: { title: string, date: string, time?: string, type: 'test'|'revision'|'deadline'|'other' }).
10. 'delete_event': user wants to delete event (payload: { eventQuery: string }).
11. 'add_label': user wants to create a new subject/topic label (payload: { labelName: string }).
12. 'delete_label': user wants to remove/delete a label (payload: { labelName: string }).
13. 'update_settings': user wants to change wallpaper, layout, accent color, or toggle sidebar (payload: { wallpaper?: string, layout?: string, collapsed?: boolean, accent?: string }).
14. 'open_settings' or 'close_settings': open or close settings modal.
15. 'sign_out': user wants to log out.

Always provide a concise, friendly confirmation in "feedback" (e.g. "Switched to Calendar view", "Added 'Optics' to Lectures", "Created label 'Revision'").`;

    let contents: any;
    if (recognizedText) {
      contents = `Student voice command: "${recognizedText}"`;
    } else if (audioBase64) {
      contents = {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/webm',
              data: audioBase64,
            },
          },
          {
            text: 'Listen to this voice command, recognize intent, and map to an action for the JEE planner application.',
          },
        ],
      };
    } else {
      return res.status(400).json({ error: 'No command text or audio received' });
    }

    const ai = getAiClient();
    const modelsToTry = MODELS;
    let lastError: any = null;

    for (const model of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                action: {
                  type: Type.STRING,
                  enum: [
                    'add_task',
                    'complete_task',
                    'delete_task',
                    'navigate_view',
                    'change_date',
                    'add_target',
                    'pin_target',
                    'delete_target',
                    'add_event',
                    'delete_event',
                    'add_label',
                    'delete_label',
                    'update_settings',
                    'open_settings',
                    'close_settings',
                    'sign_out',
                  ],
                },
                feedback: { type: Type.STRING },
                transcription: { type: Type.STRING },
                payload: {
                  type: Type.OBJECT,
                  properties: {
                    section: { type: Type.STRING, enum: ['lectures', 'hw', 'doubts'] },
                    text: { type: Type.STRING },
                    date: { type: Type.STRING },
                    labelName: { type: Type.STRING },
                    type: { type: Type.STRING, enum: ['task', 'note'] },
                    targetQuery: { type: Type.STRING },
                    view: { type: Type.STRING },
                    relativeDays: { type: Type.INTEGER },
                    targetName: { type: Type.STRING },
                    deadline: { type: Type.STRING },
                    note: { type: Type.STRING },
                    title: { type: Type.STRING },
                    time: { type: Type.STRING },
                    eventType: { type: Type.STRING, enum: ['test', 'revision', 'deadline', 'other'] },
                    eventQuery: { type: Type.STRING },
                    wallpaper: { type: Type.STRING },
                    layout: { type: Type.STRING },
                    collapsed: { type: Type.BOOLEAN },
                    accent: { type: Type.STRING },
                  },
                },
              },
              required: ['action', 'feedback', 'payload'],
            },
          },
        });

        const parsedJson = JSON.parse(response.text?.trim() || '{}');
        if (parsedJson && parsedJson.action) {
          if (!parsedJson.transcription) {
            parsedJson.transcription = recognizedText || speechText;
          }
          if (parsedJson.payload) {
            // Fix any key misplacement where date was mapped to wallpaper
            if (!parsedJson.payload.date && parsedJson.payload.wallpaper && /^\d{4}-\d{2}-\d{2}$/.test(parsedJson.payload.wallpaper)) {
              parsedJson.payload.date = parsedJson.payload.wallpaper;
              delete parsedJson.payload.wallpaper;
            }
            if (parsedJson.action === 'add_task' && !parsedJson.payload.date) {
              if ((recognizedText || speechText)?.toLowerCase().includes('tomorrow')) {
                const d = new Date(today + 'T00:00');
                d.setDate(d.getDate() + 1);
                parsedJson.payload.date = d.toISOString().slice(0, 10);
              } else {
                parsedJson.payload.date = today;
              }
            }
          }
          return res.json({ success: true, data: parsedJson });
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AI Server] Model ${model} command parsing failed, trying next... Error:`, err?.message || err);
      }
    }

    // Fallback: If text or recognized audio text provided, use rule-based command engine
    const textForFallback = recognizedText || speechText;
    if (textForFallback) {
      console.log('[AI Server] Falling back to rule-based command parser with:', textForFallback);
      const fallbackResult = ruleBasedParseCommand(textForFallback, today, existingLabels);
      fallbackResult.transcription = textForFallback;
      return res.json({ success: true, data: fallbackResult });
    }

    return res.json({
      success: true,
      data: {
        action: 'feedback_only',
        feedback: "Could not understand command clearly. Please try speaking again or select a quick command below.",
        transcription: textForFallback || '',
        payload: {},
      },
    });
  } catch (error: any) {
    console.error('Error in /api/parse-voice-command:', error);
    return res.json({
      success: true,
      data: {
        action: 'feedback_only',
        feedback: "Could not process audio. Please speak again or select a quick command below.",
        transcription: '',
        payload: {},
      },
    });
  }
}
