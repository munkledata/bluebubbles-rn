import { z } from 'zod';
import type { HttpClient } from '../http';

// POST /facetime/answer/{uuid} → { status, message, data: { link } }
const AnswerResponse = z
  .object({ data: z.object({ link: z.string() }).passthrough() })
  .passthrough();

/** Answer an incoming FaceTime call; returns the FaceTime link to open. */
export async function answerFaceTime(http: HttpClient, uuid: string): Promise<string> {
  const res = await http.post(`/facetime/answer/${encodeURIComponent(uuid)}`, AnswerResponse, {
    json: {},
  });
  return res.data.link;
}

/** Leave/decline a FaceTime call on the server side (best-effort). */
export async function leaveFaceTime(http: HttpClient, uuid: string): Promise<void> {
  await http.post(`/facetime/leave/${encodeURIComponent(uuid)}`, z.unknown(), { json: {} });
}
