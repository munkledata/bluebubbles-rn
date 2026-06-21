import { z } from 'zod';
import type { HttpClient } from '../http';

// Gator's FaceTime ops return status objects (post {status,message,data} unwrap, `data`
// IS these objects), NOT a `{ data: { link } }` envelope:
//   POST /facetime/:uuid/answer → { answered: true }
//   POST /facetime/:uuid/leave  → { left: true }
//   POST /facetime/link         → { link: string | null }   (mint a NEW FaceTime link)
const AnsweredAck = z.object({ answered: z.boolean().nullish() }).passthrough();
const LeftAck = z.object({ left: z.boolean().nullish() }).passthrough();
const FaceTimeLink = z.object({ link: z.string().nullish() }).passthrough();

/**
 * Answer an incoming FaceTime call (Private API). Returns whether the server acked the
 * answer. NOTE: unlike the legacy upstream, Gator's answer op does NOT return a join
 * link — minting a link is a separate op ({@link createFaceTimeLink}).
 */
export async function answerFaceTime(http: HttpClient, uuid: string): Promise<boolean> {
  const res = await http.post(`/facetime/${encodeURIComponent(uuid)}/answer`, AnsweredAck, {
    json: {},
  });
  return res.answered === true;
}

/** Leave/decline a FaceTime call on the server side (best-effort). Returns the ack. */
export async function leaveFaceTime(http: HttpClient, uuid: string): Promise<boolean> {
  const res = await http.post(`/facetime/${encodeURIComponent(uuid)}/leave`, LeftAck, { json: {} });
  return res.left === true;
}

/**
 * Mint a NEW FaceTime link (Private API) — `POST /facetime/link` → { link }. Used to get
 * a shareable/openable FaceTime URL (the answer op alone doesn't return one). Returns
 * null when the server couldn't produce a link.
 */
export async function createFaceTimeLink(http: HttpClient): Promise<string | null> {
  const res = await http.post('/facetime/link', FaceTimeLink, { json: {} });
  return res.link ?? null;
}
