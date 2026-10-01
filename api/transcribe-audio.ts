import { verifyUser, transcribeAudio } from '../lib/voice.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const u = await verifyUser(req.headers.authorization);
  if (!u.ok) return res.status(u.status).json({ error: u.error });
  return transcribeAudio(req, res);
}
