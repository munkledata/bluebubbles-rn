import { z } from 'zod/v4';
import { looksLikeRcsChatGuid, looksLikeRcsMessageGuid } from '@core/rcs/providerIdentity';
import { utf8Encode } from '@utils/bytes';

/** Decimal strings preserve SQLite's full signed 64-bit sequence range. */
export const MessageStateSequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
export function compareMessageStateSequence(a: string, b: string): number {
  return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;
}
export const MessageStateContext = z.object({
  version: z.literal(1),
  provider: z.literal('imessage'),
  providerEpoch: z.string().uuid(),
  ledgerEpoch: z.string().uuid(),
});
function validStateDate(event: { kind: string; dateDeleted: number | null }): boolean {
  return event.kind === 'deleted' ? event.dateDeleted != null : event.dateDeleted === null;
}
export const MessageStateEvent = z
  .object({
    sequence: MessageStateSequence.refine((value) => value !== '0'),
    kind: z.enum(['deleted', 'restored']),
    guid: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value): boolean => utf8Encode(value).byteLength <= 8192 && !looksLikeRcsMessageGuid(value),
      ),
    chatGuid: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value): boolean => utf8Encode(value).byteLength <= 8192 && !looksLikeRcsChatGuid(value),
      )
      .nullable(),
    dateDeleted: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict()
  .refine(validStateDate);
export type MessageStateEvent = z.infer<typeof MessageStateEvent>;
export const MessageStateChanged = MessageStateContext.extend(MessageStateEvent.shape)
  .strict()
  .refine(validStateDate);
export type MessageStateChanged = z.infer<typeof MessageStateChanged>;
export const MessageStatePage = MessageStateContext.extend({
  events: z.array(MessageStateEvent).max(500),
  cursor: z.string().min(1).max(2048),
  hasMore: z.boolean(),
  prunedThrough: MessageStateSequence,
  sequence: MessageStateSequence,
  boundary: MessageStateSequence,
}).strict();
export type MessageStatePage = z.infer<typeof MessageStatePage>;
export const MessageStateAuthority = MessageStateContext.extend({
  cursor: z.string().min(1).max(2048),
  /** Snapshot floor rejects delayed realtime transitions predating a successful repair. */
  snapshotSequence: MessageStateSequence,
  sequence: MessageStateSequence,
}).strict();
export type MessageStateAuthority = z.infer<typeof MessageStateAuthority>;
