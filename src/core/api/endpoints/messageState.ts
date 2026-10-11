import { MessageStatePage, MessageStateSequence } from '@core/models/messageState';
import type { HttpClient } from '../http';
import { ApiError } from '../errors';
import { z } from 'zod/v4';
import { Message } from '@core/models';

export class MessageStateRepairRequiredError extends Error {
  constructor(cause?: unknown) {
    super('A stable iMessage refresh is required before deletion sync can continue.', { cause });
    this.name = 'MessageStateRepairRequiredError';
  }
}

export async function page(
  http: HttpClient,
  cursor?: string,
  signal?: AbortSignal,
): Promise<MessageStatePage> {
  try {
    return await http.post('/sync/message-state', MessageStatePage, {
      json: { version: 1, provider: 'imessage', ...(cursor ? { cursor } : {}) },
      signal,
      retry: false,
      captureErrorDetail: true,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.serverErrorType === 'repair_required'
    ) {
      throw new MessageStateRepairRequiredError(error);
    }
    throw error;
  }
}

export async function activeMessage(
  http: HttpClient,
  guid: string,
  providerEpoch: string,
  signal?: AbortSignal,
): Promise<Message | null> {
  try {
    const result = await http.post(
      '/sync/message-state/message',
      z.object({ message: Message }).strict(),
      {
        json: { version: 1, provider: 'imessage', providerEpoch, guid },
        signal,
        retry: false,
        captureErrorDetail: true,
      },
    );
    return result.message;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.serverErrorType === 'repair_required'
    )
      throw new MessageStateRepairRequiredError(error);
    throw error;
  }
}

const PresenceGuid = z.string().min(1).max(8192);
const MessagePresencePageSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('imessage'),
    providerEpoch: z.string().uuid(),
    ledgerEpoch: z.string().uuid(),
    sequence: MessageStateSequence,
    results: z
      .array(
        z.discriminatedUnion('state', [
          z
            .object({ guid: PresenceGuid, state: z.literal('active'), chatGuid: PresenceGuid })
            .strict(),
          z.object({ guid: PresenceGuid, state: z.literal('absent') }).strict(),
          z.object({ guid: PresenceGuid, state: z.literal('ambiguous') }).strict(),
        ]),
      )
      .max(500),
  })
  .strict();
export type MessagePresencePage = z.infer<typeof MessagePresencePageSchema>;

/**
 * Typed presence for up to 500 messages at one ledger position. Only this positive answer may
 * prove a deletion: the answer must name the requested pairing and exactly the requested GUIDs in
 * order, and every other response, including an untyped 404, is an error rather than absence.
 */
export async function presence(
  http: HttpClient,
  providerEpoch: string,
  guids: readonly string[],
  signal?: AbortSignal,
): Promise<MessagePresencePage> {
  let answer: MessagePresencePage;
  try {
    answer = await http.post('/sync/message-state/presence', MessagePresencePageSchema, {
      json: { version: 1, provider: 'imessage', providerEpoch, guids: [...guids] },
      signal,
      retry: false,
      captureErrorDetail: true,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.serverErrorType === 'repair_required'
    )
      throw new MessageStateRepairRequiredError(error);
    throw error;
  }
  if (
    answer.providerEpoch !== providerEpoch ||
    answer.results.length !== guids.length ||
    answer.results.some((result, index) => result.guid !== guids[index])
  )
    throw new Error('Message presence answer does not match its request.');
  return answer;
}
