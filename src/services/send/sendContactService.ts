import type { HttpClient } from '@core/api/http';
import { sendContact, type ContactEmail, type ContactPhone } from '@core/api/endpoints/messages';
import { insertOutgoingContactWithinTransaction } from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';

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
 * STRUCTURED fields (the server builds the vCard 3.0 and ships it as an attachment), then
 * reconciles by tempGuid. The live `new-message` echo swaps the placeholder for the rendered
 * `.vcf` card seconds later. On error the bubble flips to sendState='error' (retryable via the
 * outgoing queue) — we don't rethrow into render. Pure orchestration (no React Native imports),
 * so it runs in Node tests against better-sqlite3, mirroring sendTextMessage.
 */
export async function sendContactMessage(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; contact: ContactCard; selectedMessageGuid?: string },
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
): Promise<{ tempGuid: string }> {
  if (!hasContactContent(args.contact)) {
    throw new Error('a contact needs a name, organization, phone, or email');
  }
  const tempGuid = generateTempGuid();
  // Derive the presentation label before claiming the process-wide writer. Native contact picking
  // already completed in the front door and stays entirely outside this DB-only owner.
  const displayName = contactDisplayName(args.contact);
  await withDbTransaction(
    db,
    (context) =>
      insertOutgoingContactWithinTransaction(context, {
        tempGuid,
        chatGuid: args.chatGuid,
        // Placeholder bubble text; the server echo replaces it with the rendered contact card.
        text: displayName,
        contact: args.contact,
        now,
        selectedMessageGuid: args.selectedMessageGuid,
        threadOriginatorGuid: args.selectedMessageGuid,
      }),
    commitGuard,
  );

  // The owner can commit immediately before Disconnect retires this account. Do not let the old
  // continuation use a successor account's credential boundary.
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  try {
    const server = await sendContact(http, {
      chatGuid: args.chatGuid,
      tempGuid,
      firstName: args.contact.firstName,
      lastName: args.contact.lastName,
      organization: args.contact.organization,
      phones: args.contact.phones,
      emails: args.contact.emails,
      selectedMessageGuid: args.selectedMessageGuid,
    });
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard);
  } catch (e) {
    // A revoked success-settlement owner must not be reinterpreted as a transport failure and
    // followed by a second stale-account DB attempt.
    if (e instanceof DbCommitGuardRejectedError) throw e;
    await handleSendFailure(db, tempGuid, e, 'send-contact', args.chatGuid, undefined, commitGuard);
  }

  return { tempGuid };
}
