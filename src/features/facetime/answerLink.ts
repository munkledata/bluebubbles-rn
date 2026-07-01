import { answerFaceTime, createFaceTimeLink } from '@core/api/endpoints/facetime';
import type { HttpClient } from '@core/api/http';
import { isFaceTimeLink } from '@core/facetime';
import { isDevServer } from '@utils/isDev';

/**
 * Resolve the joinable FaceTime link for an incoming call we're answering. In dev a stub
 * link is returned; otherwise Gator's answer op only acks, so we answer then mint the link
 * separately (mirrors the notification answer path). Throws if the server returns a
 * non-FaceTime link (the scheme guard).
 *
 * Kept in a leaf module (no `@/services` / `@core/api` barrel, type-only HttpClient) so it
 * stays Node-testable — the api barrel value-loads `ky`, which jest can't transform.
 */
export async function resolveFaceTimeAnswerLink(http: HttpClient, uuid: string): Promise<string> {
  if (isDevServer()) return `https://facetime.apple.com/join#v=1&p=dev&k=${uuid}`;
  await answerFaceTime(http, uuid);
  const link = await createFaceTimeLink(http);
  if (!isFaceTimeLink(link)) throw new Error('rejected non-FaceTime link');
  return link;
}
