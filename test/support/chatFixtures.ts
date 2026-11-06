import { Chat, type Handle } from '@core/models';
import { upsertChats, upsertHandles } from '@db/repositories';
import type { ReadDb } from '@db/types';

export type SeedChatParticipant = Pick<Handle, 'address' | 'service'>;

export interface SeedChatOptions {
  /** Participant handles to upsert and link; one service-less `a@x.com` handle by default. */
  readonly participants?: readonly SeedChatParticipant[];
  readonly style?: number | null;
  readonly chatIdentifier?: string | null;
  readonly providerEpoch?: string;
}

export const DEFAULT_SEED_CHAT_PARTICIPANT: SeedChatParticipant = { address: 'a@x.com' };

/**
 * Upsert one chat and its participant handles through the real repositories and return the chat's
 * row id. Suites that need richer rows (messages, read markers, raw SQL shapes, backup fixtures)
 * keep their own fixture next to the tests that depend on it.
 */
export async function seedChat(
  db: ReadDb,
  guid = 'c1',
  options: SeedChatOptions = {},
): Promise<number> {
  const participants = (options.participants ?? [DEFAULT_SEED_CHAT_PARTICIPANT]).map(
    (participant) => ({ ...participant }),
  );
  const handles = await upsertHandles(db, participants);
  const chatMap = await upsertChats(
    db,
    [
      Chat.parse({
        guid,
        participants,
        ...(options.style === undefined ? {} : { style: options.style }),
        ...(options.chatIdentifier === undefined ? {} : { chatIdentifier: options.chatIdentifier }),
        ...(options.providerEpoch === undefined ? {} : { providerEpoch: options.providerEpoch }),
      }),
    ],
    handles,
  );
  const chatId = chatMap.get(guid);
  if (chatId === undefined) throw new Error(`seedChat: chat ${guid} was not upserted`);
  return chatId;
}
