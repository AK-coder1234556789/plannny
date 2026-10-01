# JEE Planner

Day-wise tasks (Lectures, HW, Doubts), notes, labels, targets with deadlines, and a customizable countdown card. Firebase Google login with real-time sync.

## Setup
1. Create a Firebase project. Add a web app and copy its config.
2. Authentication > Sign-in method > enable Google.
3. Firestore Database > create, then paste `firestore.rules` into the Rules tab and publish.
4. `cp .env.example .env` and fill in the values.
5. `npm install` then `npm run dev`.
6. After deploying (Vercel or Netlify), add your live domain under Authentication > Settings > Authorized domains, and add the same env vars in the host's settings.

## Using it
- Calendar: month grid with done/total per day; click a day to open it.
- Analysis: daily, weekly and till-date completion, a 14-day trend, progress by section and label, and pending tasks grouped by age, section or label (with move-to-today and delete).
- Adding tasks: type and press Enter. Shift+Enter adds it as a note instead.
- Events: add a test date, revision day or deadline from the Calendar (click + on a day, or the Event button). Events show as colored chips on the calendar and on that day.
- Targets: add a name and deadline, and pin one to show it on the countdown card.
- Settings: layout (columns or stacked with side panel), icon-only sidebar, accent color, today's completion, and countdown card style.

## Not built yet
Drag-to-reorder, rename and delete labels.

## If login fails
- "Connect Firebase" screen: your .env is missing or empty. Fill it in and restart `npm run dev`.
- "This domain is not authorized": add the domain (localhost is allowed by default, your live site is not) under Authentication > Settings > Authorized domains.
- "Google sign-in is not enabled": turn on Google under Authentication > Sign-in method.
- Popup blocked (common on phones): the app automatically switches to a full-page Google sign-in.
- Sync: the sidebar shows Synced, Syncing or Offline. Offline changes are kept on the device and upload when you reconnect.

## Voice commands (AI mic)
The round mic button (bottom right) lets you add tasks, mark things done, switch views and change settings by voice. It uses the browser's speech recognition. If the AI server is reachable, Gemini understands the command; if not, a built-in parser handles common commands.

- Needs `GEMINI_API_KEY` in `.env` (server only, never commit it). Run with `npm run dev` (this starts `server.ts`).
- The AI routes only accept requests from signed-in users and are limited to 30 requests per minute per user.
- Vercel: `api/transcribe-audio.ts` and `api/parse-voice-command.ts` are Vercel functions that share `lib/voice.ts` with `server.ts`. In Vercel > Settings > Environment Variables add `GEMINI_API_KEY` and the `VITE_FIREBASE_*` values, then redeploy.
- Optional `GEMINI_MODELS` (comma separated, default `gemini-3.1-flash-lite,gemini-2.5-flash`) if a model name changes.
- Shortcut: Alt+V starts/stops the mic. After you speak and pause for about 2 seconds the command runs by itself.

## Hands-free wake word + voice setup
Turn on the **Say "..."** chip next to the mic button (remembered per device). While it is on, the page listens in the background:

- Say the wake word and pause: you hear a chime, then speak your command as usual.
- Say the wake word and the command in one go (e.g. "Planny, add chemistry homework"): it runs straight away.
- After each command it goes back to waiting. The tab must stay open.

### Set up my voice (gear button next to the chip)
1. **Your wake word**: type any word or short phrase (3 to 24 characters, up to 3 words). Very common words like "hello" or "plan" are rejected because they would trigger constantly.
2. **Language and accent**: pick e.g. English (India) or Hindi. This also sets the language for the mic button.
3. **Train my voice**: say the wake word 3 times. The browser's guesses that are close to your word are saved as extra spellings, so it recognises how *you* say it. Tap a spelling to remove it. **Test it** checks that it fires.
4. **Voice that talks back**: choose the spoken-reply voice and speed.

Settings are stored in this browser (`localStorage` key `jee_voice_setup`), not in your account. The default wake word is "Planny" (see `DEFAULT_VOICE_CFG` in `src/wakeUtil.js`).

Notes:
- This tunes *word recognition*, not *speaker recognition*: anyone who says the wake word near the mic will trigger it.
- Works in Chrome, Edge and Safari over HTTPS (or localhost). Firefox has no speech recognition.
- The browser's speech service needs internet, and Chrome sends the background audio to Google's speech servers while this is on.
- Android Chrome may click/beep each time it restarts listening; phones may stop it when the screen locks or the tab is in the background.
