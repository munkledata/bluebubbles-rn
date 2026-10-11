import type { HttpClient } from '@core/api/http';
import { sendContact, type ContactEmail, type ContactPhone } from '@core/api/endpoints/messages';
import { getChatHeader, insertOutgoingContactWithinTransaction } from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenOneToOneIMessageChat, isRcsChatGuid } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

/** Structured contact fields the client sends; the SERVER assembles the vCard from these. */
export interface ContactCard {
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones?: ContactPhone[];
  emails?: ContactEmail[];
}

/** A human label for a contact card — used for the optimistic bubble text and accessibility. */
export function contactDisplayName(c: ContactCard): string {
  const name = [c.firstName, c.lastName]
    .filter((s): s is string => !!s && !!s.trim())
    .join(' ')
    .trim();
  if (name) return name;
  if (c.organization?.trim()) return c.organization.trim();
  const phone = c.phones?.find((p) => p.number?.trim())?.number?.trim();
  if (phone) return phone;
  const email = c.emails?.find((e) => e.address?.trim())?.address?.trim();
  if (email) return email;
  return 'Contact';
}

/** True when the card carries at least one identifying field (else the server rejects it, 400). */
export function hasContactContent(c: ContactCard): boolean {
  return Boolean(
    c.firstName?.trim() ||
    c.lastName?.trim() ||
    c.organization?.trim() ||
    c.phones?.some((p) => p.number?.trim()) ||
    c.emails?.some((e) => e.address?.trim()),
  );
}

/**
 * Optimistic contact-card send. Inserts a temp bubble showing the contact's name, POSTs the
 * STRUCTURED fields (the server builds the vCard 3.0 and uses the service-specific contact path), then
 * reconciles by tempGuid. The live `new-message` echo swaps the placeholder for the rendered
 * `.vcf` card seconds later. A failed RCS card retries. An iMessage card is one-shot: any failure is
 * final, recorded as not sent when the server proved it refused the card and as unconfirmed
 * otherwise, so neither the queue nor “Try Again” can duplicate it. Pure orchestration (no React
 * Native imports), so it runs in Node tests against better-sqlite3, mirroring sendTextMessage.
 */
export async function sendContactMessage(
  db: AppDatabase,
  http: HttpClient,
  args: {
    chatGuid: string;
    contact: ContactCard;
    selectedMessageGuid?: string;
    partIndex?: number;
  },
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  /** Explicit provenance for foreground cache data or already-proven task-local server info. */
  capabilitySource?: RcsCapabilitySource,
  /** Fires only after the optimistic message and durable retry row commit. */
  onQueued?: (tempGuid: string) => void | Promise<void>,
): Promise<{ tempGuid: string }> {
  const rcsChat = isRcsChatGuid(args.chatGuid);
  if (args.selectedMessageGuid !== undefined || args.partIndex !== undefined) {
    throw new Error('This server cannot send a contact-card reply.');
  }
  if (!hasContactContent(args.contact)) {
    throw new Error('a contact needs a name, organization, phone, or email');
  }
  const transport = pinSendTransport(http, commitGuard);
  const tempGuid = generateTempGuid();
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    args.chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: true },
  );
  const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
  if (
    (rcsChat && capability.serverInfo?.rcs !== true) ||
    (!rcsChat && capability.serverInfo?.supports_send_contact !== true)
  ) {
    throw new Error('This server cannot send a contact card for this chat service.');
  }
  if (!rcsChat) {
    const header = await getChatHeader(db, args.chatGuid);
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    if (!isProvenOneToOneIMessageChat(header)) {
      throw new Error('A proven existing one-to-one iMessage chat is required.');
    }
  }
  // Derive the presentation label before claiming the process-wide writer. Native contact picking
  // already completed in the front door and stays entirely outside this DB-only owner.
  const displayName = contactDisplayName(args.contact);
  const { attemptOwnerToken } = await withDbTransaction(
    db,
    (context) =>
      insertOutgoingContactWithinTransaction(context, {
        tempGuid,
        chatGuid: args.chatGuid,
        // Placeholder bubble text; the server echo replaces it with the rendered contact card.
        text: displayName,
        contact: args.contact,
        now,
        attemptAware: capability.attemptAware,
      }),
    capabilityGuard,
  );
  await onQueued?.(tempGuid);

  // The owner can commit immediately before Disconnect retires this account. Do not let the old
  // continuation use a successor account's credential boundary.
  if (!capabilityGuard()) throw new DbCommitGuardRejectedError();

  try {
    transport.assertNetworkCurrent();
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    const server = await sendContact(transport.http, {
      chatGuid: args.chatGuid,
      tempGuid,
      clientAttemptGeneration: attemptOwnerToken?.generation,
      firstName: args.contact.firstName,
      lastName: args.contact.lastName,
      organization: args.contact.organization,
      phones: args.contact.phones,
      emails: args.contact.emails,
    });
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard, {
      attemptOwnerToken: attemptOwnerToken ?? undefined,
      expectedChatGuid: args.chatGuid,
    });
  } catch (e) {
    // A revoked success-settlement owner must not be reinterpreted as a transport failure and
    // followed by a second stale-account DB attempt.
    if (e instanceof DbCommitGuardRejectedError) throw e;
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    await handleSendFailure(
      db,
      tempGuid,
      e,
      'send-contact',
      args.chatGuid,
      undefined,
      commitGuard,
      {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
        ...(rcsChat ? {} : { terminalUncertainKind: 'contact' as const }),
      },
    );
  }

  return { tempGuid };
}
