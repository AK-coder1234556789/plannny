import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { transcribeAudio, parseVoiceCommand } from './lib/voice.js';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fbConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf8'));

const app = express();

const portFlagIdx = process.argv.indexOf('--port') !== -1 ? process.argv.indexOf('--port') : process.argv.indexOf('-p');
const parsedArgPort = portFlagIdx !== -1 && process.argv[portFlagIdx + 1] ? parseInt(process.argv[portFlagIdx + 1], 10) : undefined;
const PORT = parsedArgPort || (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
const HOST = '0.0.0.0';

app.use(express.json({ limit: '15mb' }));

// Only signed-in planner users may call the AI routes (protects the Gemini quota).
// The browser sends its Firebase ID token; we verify it with Firebase and rate-limit per user.
const hits = new Map<string, number[]>();
async function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbConfig.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired sign-in' });
    const data: any = await r.json();
    const uid = data?.users?.[0]?.localId;
    if (!uid) return res.status(401).json({ error: 'Invalid sign-in' });
    const now = Date.now();
    const recent = (hits.get(uid) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 30) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    recent.push(now);
    hits.set(uid, recent);
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Could not verify sign-in' });
  }
}

app.post('/api/log-client-error', (req, res) => {
  console.error('[BROWSER CLIENT ERROR]:', JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Shared Gemini client
const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) console.warn('[AI Server] GEMINI_API_KEY is missing');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

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

// API: Parse voice speech or audio into a structured JEE Planner task
app.post('/api/parse-voice-task', requireUser, async (req, res) => {
  try {
    const { speechText, audioBase64, mimeType, currentDate, existingLabels } = req.body;

    if (!speechText && !audioBase64) {
      return res.status(400).json({ error: 'Either speechText or audioBase64 is required' });
    }

    const today = currentDate || new Date().toISOString().slice(0, 10);
    const dayOfWeek = new Date(today + 'T00:00').toLocaleDateString('en-US', { weekday: 'long' });

    const systemInstruction = `You are an expert AI parser for a JEE (Joint Entrance Examination) student study planner.
The student speaks voice commands to quickly add study tasks, homework, or doubts to their planner.
Reference context:
- Current today's date is: ${today} (${dayOfWeek}).
- Existing available subject labels in planner: ${JSON.stringify(existingLabels || ['Physics', 'Chemistry', 'Maths'])}.
- Valid planner sections are strictly: 'lectures', 'hw', 'doubts'.

Mapping Rules:
1. section:
   - 'lectures': lecture, class, video, session, theory, watch, attend.
   - 'hw': homework, hw, practice, dpp, sheet, questions, problem set, exercise, solve, assignment.
   - 'doubts': doubt, query, question for sir, clarify, ask, confusion.
   - If not clearly specified, choose 'lectures' for topics/classes, 'hw' for problem solving, or 'doubts' for queries.
2. text:
   - Clean, well-capitalized, concise task title (e.g. "Geometrical Optics Lecture 1", "HC Verma Ch 10 Q1-25", "Doubt in Rolling Friction").
   - Strip redundant prefix/suffix command words like "add to lectures", "please add", "put in hw", etc.
3. date:
   - If a specific date or relative day is mentioned (e.g. "tomorrow", "day after tomorrow", "yesterday", "next Monday", "Friday", "Oct 12"):
     Calculate the exact YYYY-MM-DD based on today (${today}, ${dayOfWeek}).
   - IF NO DATE IS SPECIFIED, ALWAYS return today's date: ${today}.
4. labelName:
   - Subject or topic tag (e.g. "Physics", "Chemistry", "Maths", or custom).
   - Infer from context if obvious (e.g. "Optics", "Mechanics", "Thermodynamics" -> "Physics"; "Organic", "Coordination", "Physical" -> "Chemistry"; "Calculus", "Integration", "Algebra", "Coordinate" -> "Maths").
   - If unsure or general, return null or the closest match.
5. type:
   - 'note' if they specifically state "add note" or "as note".
   - otherwise 'task'.
6. feedback:
   - A friendly, encouraging 1-sentence confirmation suitable for text/speech feedback (e.g. "Added 'Geometrical Optics Lecture 1' to Lectures for today!").`;

    let contents: any;
    if (audioBase64) {
      contents = {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/webm',
              data: audioBase64,
            },
          },
          {
            text: `Listen to this student voice command, transcribe it, and extract the task details according to instructions.`,
          },
        ],
      };
    } else {
      contents = `Student voice input: "${speechText}"`;
    }

    const ai = getAiClient();
    const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
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
                section: {
                  type: Type.STRING,
                  enum: ['lectures', 'hw', 'doubts'],
                  description: 'The target section in the planner',
                },
                text: {
                  type: Type.STRING,
                  description: 'The cleaned title of the task without command keywords',
                },
                date: {
                  type: Type.STRING,
                  description: 'ISO date YYYY-MM-DD for this task',
                },
                labelName: {
                  type: Type.STRING,
                  description: 'Optional subject or topic label name like Physics, Chemistry, Maths',
                },
                type: {
                  type: Type.STRING,
                  enum: ['task', 'note'],
                  description: 'Task checkbox item or informational note',
                },
                transcription: {
                  type: Type.STRING,
                  description: 'The exact words recognized from speech',
                },
                feedback: {
                  type: Type.STRING,
                  description: 'Short confirmation feedback sentence',
                },
              },
              required: ['section', 'text', 'date', 'type', 'feedback'],
            },
          },
        });

        const parsedJson = JSON.parse(response.text?.trim() || '{}');
        if (parsedJson && parsedJson.text) {
          if (!parsedJson.transcription && speechText) {
            parsedJson.transcription = speechText;
          }
          return res.json({ success: true, data: parsedJson });
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AI Server] Model ${model} failed, trying next... Error:`, err?.message || err);
      }
    }

    // Fallback: If text input is provided and AI models are experiencing quota/503 spikes
    if (speechText) {
      console.log('[AI Server] Using resilient rule-based parser fallback');
      const fallbackResult = ruleBasedParseTask(speechText, today, existingLabels);
      return res.json({ success: true, data: fallbackResult });
    }

    throw lastError || new Error('Failed to analyze voice task with AI');
  } catch (error: any) {
    console.error('Error in /api/parse-voice-task:', error);
    return res.status(500).json({
      error: error.message || 'Failed to analyze voice task with AI',
    });
  }
});

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

// API: audio transcription + voice command parsing (shared with the Vercel functions in /api)
app.post('/api/transcribe-audio', requireUser, transcribeAudio);
app.post('/api/parse-voice-command', requireUser, parseVoiceCommand);

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: HOST,
        port: PORT,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[AI Studio] JEE Planner server running at http://${HOST}:${PORT}`);
  });
}

startServer();
