// Helpers for the custom wake word + "set up my voice" feature.
// Pure functions (no React / browser APIs) so they are easy to test.

export const DEFAULT_VOICE_CFG = {
  phrase: 'Planny',
  // Other ways speech engines tend to write the default word
  aliases: ['plany', 'plannie', 'planni', 'planney'],
  lang: '', // '' = use the browser language
  voiceURI: '', // '' = browser default voice for spoken replies
  rate: 1.05, // speed of spoken replies
};

// Words that would fire constantly in normal talk or clash with commands
const TOO_COMMON = new Set([
  'the', 'and', 'you', 'hey', 'hi', 'hello', 'ok', 'okay', 'yes', 'no', 'stop', 'go', 'add', 'open',
  'done', 'task', 'tasks', 'plan', 'planning', 'study', 'next', 'today', 'delete', 'settings', 'note',
]);

export function normalizePhrase(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns '' when OK, otherwise a short message to show the user
export function validatePhrase(raw) {
  const p = normalizePhrase(raw);
  if (p.length < 3) return 'Use at least 3 letters.';
  if (p.length > 24) return 'Keep it under 24 characters.';
  if (p.split(' ').length > 3) return 'Use at most 3 words.';
  if (TOO_COMMON.has(p)) return `"${p}" is too common, so it would trigger all the time. Pick something more unique.`;
  return '';
}

export function isTooCommon(word) {
  return TOO_COMMON.has(normalizePhrase(word));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "hey buddy" -> matches "hey buddy" and "heybuddy"
function patternFor(phrase) {
  const p = normalizePhrase(phrase);
  if (!p) return '';
  const words = p.split(' ').map(escapeRe);
  return words.length > 1 ? words.join('\\s*') : words[0];
}

export function buildWakeRegex(phrase, aliases = []) {
  const all = [phrase, ...(aliases || [])].map(patternFor).filter(Boolean);
  const alts = Array.from(new Set(all)).sort((a, b) => b.length - a.length);
  if (!alts.length) alts.push(patternFor(DEFAULT_VOICE_CFG.phrase));
  const body = '(?:' + alts.join('|') + ')';
  try {
    // Unicode-aware word edges (works for Hindi etc.). Older Safari lacks lookbehind.
    return new RegExp('(?<![\\p{L}\\p{M}\\p{N}])' + body + '(?![\\p{L}\\p{M}\\p{N}])', 'iu');
  } catch {
    return new RegExp('\\b' + body + '\\b', 'i');
  }
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Given what the engine returned while the user said their wake word, decide
// which spellings are close enough to keep as aliases. Anything far from the
// phrase (e.g. the engine heard "hello") is ignored so training can't add junk.
export function aliasesFromHeard(phrase, heardList) {
  const target = normalizePhrase(phrase);
  const flat = target.replace(/ /g, '');
  const limit = Math.max(1, Math.floor(flat.length / 3));
  const out = [];
  for (const h of heardList || []) {
    const n = normalizePhrase(h);
    if (!n || n === target) continue;
    if (n.split(' ').length > 3 || n.length > 24) continue;
    if (isTooCommon(n)) continue;
    if (levenshtein(n.replace(/ /g, ''), flat) > limit) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
