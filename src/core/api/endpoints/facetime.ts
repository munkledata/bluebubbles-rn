import { z } from 'zod';
import type { HttpClient } from '../http';

// Gator's FaceTime ops return status objects (post {status,message,data} unwrap, `data`
// IS these objects), NOT a `{ data: { link } }` envelope:
//   POST /facetime/:uuid/answer → { answered: true }
//   POST /facetime/:uuid/leave  → { left: true }
//   POST /facetime/link         → { link: string | null }   (mint a NEW FaceTime link)
//   POST /facetime/call         → { call_uuid, link }        (place an OUTGOING call)
const AnsweredAck = z.object({ answered: z.boolean().nullish() }).passthrough();
const LeftAck = z.object({ left: z.boolean().nullish() }).passthrough();
const FaceTimeLink = z.object({ link: z.string().nullish() }).passthrough();
const StartCallResult = z
  .object({ call_uuid: z.string().nullish(), link: z.string().nullish() })
  .passthrough();

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
export async function createFaceTimeLink(
  http: HttpClient,
  addresses?: string[],
): Promise<string | null> {
  // Pass recipient addresses so the server invites them into the link (it arrives in their
  // FaceTime as an invite, not just a tappable URL). Omitted → a plain link.
  const json = addresses && addresses.length > 0 ? { addresses } : {};
  const res = await http.post('/facetime/link', FaceTimeLink, { json });
  return res.link ?? null;
}

/**
 * Place an OUTGOING FaceTime call (Private API native dial) to one or more addresses —
 * the Mac's FaceTime rings the recipient(s) from your registered number/identity. The
 * server also mints a join link for the placed call so you can join the media from the
 * in-app WebView. `POST /facetime/call` → `{ call_uuid, link }`. Either field may be
 * null if the server placed the call but couldn't return it (e.g. link mint failed).
 */
export async function startFaceTimeCall(
  http: HttpClient,
  args: { addresses: string[]; video: boolean; from?: string },
): Promise<{ callUuid: string | null; link: string | null }> {
  const res = await http.post('/facetime/call', StartCallResult, {
    // `from` (optional): the local sender identity to ring as (e.g. your phone number).
    // Omitted → the Mac's default FaceTime "from" identity.
    json: {
      addresses: args.addresses,
      video: args.video,
      ...(args.from ? { from: args.from } : {}),
    },
  });
  return { callUuid: res.call_uuid ?? null, link: res.link ?? null };
}
