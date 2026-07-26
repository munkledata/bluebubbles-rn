import { and, eq, ne, sql } from 'drizzle-orm';
import type { MessageMention } from '@core/api/endpoints/messages';
import { chats, messages, outgoingQueue } from '../schema';
import { withDbTransaction } from '../transaction';
import type { AppDatabase } from '../types';
// The ONE tombstone write (stamp `date_deleted` + recompute the chat's denormalized sort key).
// Imported from the module that owns it rather than restated here, so the two can't drift;
// messages.ts imports nothing from this file, so there is no cycle.
import { markMessageDeleted } from './messages';

/** Server fields used to promote an optimistic message to its real identity. */
export interface ServerMsgFields {
  /**
   * The real server GUID. ABSENT on the AppleScript send path (the helper isn't
   * connected, so the server can't ack a GUID) — callers MUST NOT invoke this with an
   * undefined guid; instead they call `markOutgoingSentNoGuid`, and the live socket
   * `new-message` echo reconciles the optimistic row by CONTENT (`reconcileEchoByContent`,
   * since Gator's echo carries no tempGuid). The guard below is a belt-and-braces backstop.
   */
  guid: string;
  dateCreated: number | null;
  dateDelivered: number | null;
}

/**
 * A CANCELLED SEND IS A TOMBSTONE, NEVER A HARD DELETE — the one rule behind every path below.
 *
 * Cancelling cannot unsend what the server already accepted, and no local state proves it did not:
 * a 'sending' row has a POST in flight by definition, and an 'error' row can be a send that timed
 * out client-side (30 s) after the server processed it — which is exactly why the two content
 * reconcilers deliberately match 'error' rows. So the message will come back: from the live echo,
 * from the RCS fanout materializing `rcs-<id>` minutes later, or from `ensureChatSynced`'s
 * 500-message re-page on the very next chat open. Removing the row destroys the only thing that
 * later identity can inherit the deletion from.
 *
 * `date_deleted` survives all of it. The reconcilers promote IN PLACE (they rewrite guid /
 * send_state / error and nothing else), so the tombstone rides onto the real guid, and the column
 * is deliberately absent from `upsertMessages`' conflict set, so every later re-page leaves it
 * standing. Every render/count/search query filters it out, so the bubble VANISHES and stays gone.
 *
 * This replaced an in-memory set of "cancelled while in flight" temp guids consulted on the ack
 * paths. That could not work: it died with the process, and it was never consulted on the
 * INGESTION path (`upsertMessages`), which is what actually re-creates the row.
 */

/**
 * INSERT ATOMICITY, shared by all four optimistic-send helpers: the queue row and the visible
 * message row commit TOGETHER, in ONE transaction. Neither half is any use alone, and both
 * failure modes are silent:
 *  - message without a queue row → a bubble frozen on 'sending' forever. Nothing recovers it (the
 *    retry processor reads `outgoing_queue` only, and unlike scheduled_messages nothing resets a
 *    stuck `send_state='sending'` at boot), so the message is silently never sent.
 *  - queue row without a message → the drain re-POSTs it from the self-contained payload with no
 *    bubble anywhere. That is not only a crash story: the messages INSERT can throw on its own (a
 *    `messages.chat_id REFERENCES chats(id)` failure if the chat row went away mid-send, or the
 *    FTS trigger), and then the send the caller just reported as FAILED goes out ~60 s later
 *    anyway — after the user retyped it, so the recipient gets it twice.
 * As separate autocommits no ORDER avoids both (which is why ordering them was not enough); the
 * transaction does. Every statement is short + DB-only and no caller is itself inside a
 * transaction, so the no-nesting rule holds. `countOutgoingQueueHealth` reports whether either
 * half is ever stranded on a real device.
 */

/** Optimistically insert an outgoing text message + its queue row, and bump the chat. */
export async function insertOutgoingText(
  db: AppDatabase,
  args: {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    text: string;
    now: number;
    selectedMessageGuid?: string;
    threadOriginatorGuid?: string;
    effectId?: string;
    subject?: string;
    mentions?: MessageMention[];
  },
): Promise<void> {
  // ONE transaction — see the insert-atomicity note directly above.
  await withDbTransaction(db, async () => {
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'text',
      payload: JSON.stringify({
        message: args.text,
        selectedMessageGuid: args.selectedMessageGuid,
        effectId: args.effectId,
        subject: args.subject,
        // Persisted so a crash-recovery resend keeps the subject + mention spans
        // (the queue re-POST builds its request from this payload alone).
        mentions: args.mentions?.length ? args.mentions : undefined,
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId: args.chatId,
      text: args.text,
      subject: args.subject ?? null,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      // Persist locally so an optimistic reply renders its quote + the send-effect
      // plays on the outgoing bubble before the server echo.
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
      expressiveSendStyleId: args.effectId ?? null,
    });
    await db.update(chats).set({ latestMessageDate: args.now }).where(eq(chats.id, args.chatId));
  });
}

/**
 * Optimistic CONTACT-CARD send: the same placeholder bubble as a text send, but queued under
 * `kind:'contact'` so a retry re-POSTs the STRUCTURED contact fields.
 *
 * This kind exists specifically so a failed contact send cannot be retried as a text message.
 * Queuing it as `kind:'text'` (what this used to do) made `runOutgoingQueue` re-send the
 * bubble's placeholder — the contact's display NAME — as a plain message, so the recipient got
 * "Craig Federighi" instead of a card and the bubble flipped to 'sent'.
 *
 * `text` is the caller-supplied placeholder (the contact's display name); the payload carries
 * the structured fields the server needs to rebuild the vCard on a retry.
 */
export async function insertOutgoingContact(
  db: AppDatabase,
  args: {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    /** Placeholder bubble text (the contact's display name). */
    text: string;
    contact: {
      firstName?: string;
      lastName?: string;
      organization?: string;
      phones?: unknown[];
      emails?: unknown[];
    };
    now: number;
    selectedMessageGuid?: string;
    threadOriginatorGuid?: string;
  },
): Promise<void> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  await withDbTransaction(db, async () => {
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'contact',
      payload: JSON.stringify({
        firstName: args.contact.firstName,
        lastName: args.contact.lastName,
        organization: args.contact.organization,
        phones: args.contact.phones?.length ? args.contact.phones : undefined,
        emails: args.contact.emails?.length ? args.contact.emails : undefined,
        selectedMessageGuid: args.selectedMessageGuid,
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId: args.chatId,
      text: args.text,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
    });
    await db.update(chats).set({ latestMessageDate: args.now }).where(eq(chats.id, args.chatId));
  });
}

/**
 * Optimistically insert an outgoing reaction (an associated message row) + its
 * queue row. Unlike a text send this does NOT bump latestMessageDate — a tapback
 * must not reorder the inbox. `reaction` is e.g. 'love' or '-love' (removal).
 */
export async function insertOutgoingReaction(
  db: AppDatabase,
  args: {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    targetGuid: string;
    reaction: string;
    /** Glyph for an 'emoji'/'-emoji' tapback; persisted so the optimistic badge renders it. */
    emoji?: string;
    selectedMessageText?: string;
    now: number;
  },
): Promise<void> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  await withDbTransaction(db, async () => {
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'reaction',
      payload: JSON.stringify({
        selectedMessageGuid: args.targetGuid,
        reaction: args.reaction,
        ...(args.emoji ? { emoji: args.emoji } : {}),
        selectedMessageText: args.selectedMessageText ?? '',
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId: args.chatId,
      text: null,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      associatedMessageGuid: args.targetGuid,
      associatedMessageType: args.reaction,
      associatedMessageEmoji: args.emoji ?? null,
    });
  });
}

/**
 * Remove a not-yet-confirmed optimistic send — the ONE guarded write behind both user
 * affordances ("Cancel Sending" on a live send, "Delete"/"Remove" on a failed one), exported
 * under both names. Returns whether this call OWNED the message: false ⇒ it is not an
 * unconfirmed row of ours and the caller must apply the ordinary local-delete (tombstone) path.
 *
 * THE WHOLE DECISION IS IN THE WRITE. A `SELECT … then DELETE` was the bug: the tap races the
 * 20 s retry drain, which leases the row, flips it to 'sending' and starts a POST that can run for
 * seconds, while the sheet the user is tapping shows the state from when it opened. What the write
 * matches is therefore the only trustworthy answer, and the compare-and-set matches ONLY a
 * `temp-…` row still in an unconfirmed state ('sending' or 'error'):
 *  - a row promoted to 'sent' in the gap survives untouched — on the guid-less ack paths (RCS
 *    bridge / AppleScript) a SUCCESSFUL send keeps its temp guid, so hard-deleting it would remove
 *    a message the recipient already has and the server echo would re-insert it as a fresh bubble;
 *  - a real (server-issued) guid is never matched: it belongs on the caller's ordinary tombstone
 *    path, which recomputes the chat's sort key and reports "unknown guid" honestly.
 *
 * What it writes is a TOMBSTONE, not a row removal — see the cancelled-send rule at the top of this
 * file. Both matched states can correspond to a message the server already has, and the row is what
 * the later echo/fanout/re-page promotes in place, carrying `date_deleted` onto the real identity.
 *
 * The queue row goes in BOTH branches, inside the same transaction. When we tombstoned the bubble
 * the ladder must not outlive it (an orphan queue row re-sends blind on the next drain — a message
 * the user explicitly cancelled, with nothing on screen to tell them). When we did NOT match — an
 * orphan row, or a bubble the caller is about to tombstone itself — a surviving ladder would
 * re-POST behind the user's back the thing they just deleted.
 *
 * Reporting "owned" for a queue-row-only cleanup is what this must never do again: the Delete path
 * treats true as "handled" and skips the tombstone, so the message the user asked to delete stayed
 * on screen with no error while its retry ladder was silently stripped.
 */
export async function discardOutgoingMessage(
  db: AppDatabase,
  guid: string,
  now: number = Date.now(),
): Promise<boolean> {
  return withDbTransaction(db, async () => {
    const owned = await db.all<{ id: number }>(sql`
      UPDATE messages SET date_deleted = ${now}
       WHERE guid = ${guid} AND guid LIKE 'temp-%' AND send_state IN ('sending', 'error')
      RETURNING id`);
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, guid));
    if (owned.length === 0) return false;
    // Re-stamp through the shared tombstone helper for its SECOND effect: recomputing the chat's
    // denormalized latest_message_date. Cancelling the newest message otherwise leaves the inbox
    // sorted (and previewing) on a row nothing renders. Idempotent — the stamp above already
    // decided; this only repeats it.
    await markMessageDeleted(db, guid, now);
    return true;
  });
}

/**
 * "Cancel Sending" — the same write as {@link discardOutgoingMessage}. The two affordances differ
 * only in the wording of their dialog: both ask for an unconfirmed optimistic send to be removed,
 * and both must refuse a send that already left the device. Kept as a name so the call sites read
 * as what the user tapped.
 */
export const cancelOutgoing = discardOutgoingMessage;

/** What {@link claimFailedOutgoingForRetry} found when it tried to take the row over. */
export type RetryClaim =
  /** The errored row is now 'sending' and its queue payload is handed back — re-POST it. */
  | 'claimed'
  /** An automatic retry currently owns it (a POST is in flight) — do nothing. */
  | 'sending'
  /** Already sent/promoted/gone — re-sending would deliver a second copy. */
  | 'settled'
  /**
   * No queue row, so there is no payload to re-POST and no honest way to rebuild one — an errored
   * bubble whose ladder the RCS immediate ack consumed, or a real server guid that failed after
   * delivery. Nothing is written.
   */
  | 'unsendable';

/** The outcome of {@link claimFailedOutgoingForRetry}; `row` is present only when 'claimed'. */
export interface RetryHandover {
  claim: RetryClaim;
  /** The QUEUE payload to re-POST, under the row's ORIGINAL temp guid. */
  row?: RetryableOutgoing;
}

/**
 * Take over a FAILED optimistic send so the caller can re-send it — under the SAME temp guid, from
 * the SAME queue payload.
 *
 * The state flip is a compare-and-set on `send_state = 'error'`, and that guard is the whole point.
 * The retry sheet holds a snapshot from the moment it opened, but the 20 s drain claims eligible
 * rows continuously and flips them to 'sending' before every POST — so by the time the user taps
 * "Try Again" the row may be mid-flight (a second POST would deliver a second copy) or already
 * delivered (the guid-less ack paths keep the temp guid). Only an 'error' row is ours to re-send;
 * the other outcomes are reported so the caller can say so instead of silently duplicating.
 *
 * TWO THINGS THIS MUST NOT DO, both of which it used to.
 *  - MINT A NEW TEMP GUID. It deleted the row so the caller could re-send from scratch, but the
 *    server's idempotency cache is keyed on exactly that id: a send that failed client-side (a
 *    30 s HTTP timeout) yet landed server-side is then dispatched a SECOND time under the new key.
 *    The automatic drain never had this bug because it re-POSTs under `row.tempGuid`.
 *  - REBUILD THE SEND FROM THE BUBBLE. The caller only has what is on screen, so a failed CONTACT
 *    CARD went out as a plain text message reading the contact's display name — precisely the
 *    outcome `kind:'contact'` exists to prevent — and a reply lost its target, a send lost its
 *    effect id, subject and mention spans. Only the queue payload carries those, so the payload is
 *    what is handed back.
 * Nothing is destroyed either: the row the user is trying to rescue survives the claim, so a throw
 * in the re-send (or a process death) leaves a failed bubble and a live ladder rather than nothing.
 *
 * ONE transaction, and only ONE thing in it decides: the compare-and-set on the message. The queue
 * payload is read first, but that read is not a decision — inside the transaction nothing can
 * change under it, and with no payload there is simply nothing to re-POST ('unsendable': an
 * attachment retired because its on-disk file is gone, or a ladder the RCS immediate ack consumed).
 * A refused claim therefore writes nothing at all, so it can never strip the ladder off a send that
 * is in flight. A claimed one re-arms that ladder in the same transaction as the flip — attempts
 * reset, because the button is the ONLY recourse for a row already retired at the attempt cap, and
 * leased, so a drain tick can't re-POST the same payload alongside the caller's own attempt.
 */
export async function claimFailedOutgoingForRetry(
  db: AppDatabase,
  tempGuid: string,
  now: number = Date.now(),
): Promise<RetryHandover> {
  return withDbTransaction(db, async () => {
    const queued = await db.all<RetryableOutgoing>(sql`
      SELECT id, temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts,
             created_at AS createdAt
      FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`);
    const row = queued[0];
    if (!row) return { claim: 'unsendable' };
    const taken = await db.all<{ id: number }>(sql`
      UPDATE messages SET send_state = 'sending', error = 0
       WHERE guid = ${tempGuid} AND send_state = 'error'
      RETURNING id`);
    if (taken.length === 0) {
      // Read AFTER the failed compare-and-set, and only to word the message to the user — no write
      // depends on it, so a stale answer here is harmless.
      const cur = await db.all<{ sendState: string | null }>(
        sql`SELECT send_state AS sendState FROM messages WHERE guid = ${tempGuid} LIMIT 1`,
      );
      return { claim: cur[0]?.sendState === 'sending' ? 'sending' : 'settled' };
    }
    await db.run(sql`
      UPDATE outgoing_queue SET attempts = 0, next_retry_at = ${now + OUTGOING_LEASE_MS}
       WHERE temp_guid = ${tempGuid}`);
    return { claim: 'claimed', row: { ...row, attempts: 0 } };
  });
}

/**
 * Reconcile a successful send. If the real message already exists (the socket
 * echo landed first via DbEventSink), drop the temp row; otherwise promote the
 * temp row to the real guid in place. Either way, no duplicate (guid is unique).
 *
 * A send the user CANCELLED needs no branch of its own: the discard left a TOMBSTONED temp row
 * (see the rule at the top of this file), the promote below rewrites guid/send_state/error and
 * nothing else, so `date_deleted` rides onto the real identity and the message stays hidden through
 * every later re-page. The dup branch has to move it by hand — that is the one place the temp row
 * is destroyed rather than promoted.
 *
 * The promote (or dup-drop) and the queue-row delete commit in ONE transaction. As two
 * autocommits, a process death in the gap left an orphan queue row whose temp_guid no longer
 * names any message: after the grace window the drain re-POSTs that payload, and once the
 * server's idempotency TTL has lapsed (an overnight kill) the recipient gets the message twice,
 * with no local bubble for the second copy until its echo inserts one. Same reasoning as
 * `DbEventSink`, which reconciles inside its own transaction for exactly this pair of writes.
 */
export async function reconcileOutgoingSuccess(
  db: AppDatabase,
  tempGuid: string,
  server: ServerMsgFields,
): Promise<void> {
  // Backstop: never promote a row to an undefined/empty guid. The AppleScript send path
  // returns no GUID ack, so callers leave reconciliation to the socket `new-message`
  // echo (which carries tempGuid); if a caller slips through, no-op rather than corrupt
  // the optimistic row's guid to NULL.
  if (!server.guid) return;
  // Backstop: an RCS (bridge) send acks back the SAME tempGuid we passed as its correlation
  // token — NOT a real message guid (the real one, `rcs-<id>`, only arrives on the live
  // `new-message` fanout). Promoting a row to its OWN temp guid is meaningless AND destructive:
  // the dup-branch below would find the temp row as its own "duplicate" and DELETE it, taking a
  // just-sent image's on-disk local_path with it (the picture then re-appears from the fanout with
  // no local file → a download/reload button). Treat it exactly like the guid-absent AppleScript
  // fallback: flip to 'sent', drop the queue row, and let the fanout reconcile by content.
  if (server.guid === tempGuid) {
    await markOutgoingSentNoGuid(db, tempGuid);
    return;
  }
  await withDbTransaction(db, async () => {
    const dup = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${server.guid} LIMIT 1`,
    );
    if (dup[0]) {
      // The live echo already inserted the real message (it beat this ack, and content-match
      // didn't promote our temp row — e.g. an edge where the text differs). Carry any on-disk
      // local_path from the temp row's attachment onto the real row's attachment BEFORE the
      // cascade-delete, so a just-sent image isn't lost to a re-download. (One attachment per
      // outgoing message in this app.)
      const tempAtt = await db.all<{ localPath: string | null }>(
        sql`SELECT ta.local_path AS localPath FROM attachments ta
            JOIN messages tm ON tm.id = ta.message_id
            WHERE tm.guid = ${tempGuid} AND ta.local_path IS NOT NULL LIMIT 1`,
      );
      const lp = tempAtt[0]?.localPath;
      if (lp) {
        // db.run (not db.all) — a non-returning UPDATE; db.all throws "use run()" on better-sqlite3.
        await db.run(
          sql`UPDATE attachments SET local_path = ${lp} WHERE message_id = ${dup[0].id} AND local_path IS NULL`,
        );
      }
      // Carry a local DELETION across too. This is the ONE path that destroys the temp row instead
      // of promoting it, so a send the user cancelled/deleted mid-flight would otherwise leave the
      // echo's copy VISIBLE — and `date_deleted` is the only column `upsertMessages` never
      // overwrites, so nothing later would hide it again.
      const tomb = await db.all<{ dateDeleted: number | null }>(
        sql`SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ${tempGuid} LIMIT 1`,
      );
      const dd = tomb[0]?.dateDeleted;
      if (dd != null) await markMessageDeleted(db, server.guid, dd);
      await db.delete(messages).where(eq(messages.guid, tempGuid));
    } else {
      await db
        .update(messages)
        .set({
          guid: server.guid,
          dateCreated: server.dateCreated ?? undefined,
          dateDelivered: server.dateDelivered ?? null,
          isFromMe: true,
          sendState: 'sent',
          error: 0,
        })
        .where(eq(messages.guid, tempGuid));
    }
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

/**
 * Reconcile a send that SUCCEEDED but returned no GUID (the AppleScript fallback path).
 * The message left the device, so: drop the queue row (no more retries) and flip the
 * still-temp optimistic bubble to 'sent'. Its identity stays the tempGuid until the socket
 * `new-message` echo (which carries the tempGuid) promotes it to the real guid. Used by the
 * send services and the retry processor for the absent-guid case.
 *
 * The promote and the queue-row delete commit in ONE transaction, for the same reason as
 * {@link reconcileOutgoingSuccess}: as two autocommits, a death in the gap leaves a 'sent' bubble
 * whose queue row survives, and the next launch's drain re-sends a message already delivered.
 *
 * A cancelled send needs no branch here either: the discard already TOMBSTONED the row, and this
 * write touches send_state/error only, so the message stays hidden while keeping the identity the
 * fanout will promote (see the cancelled-send rule at the top of this file).
 */
export async function markOutgoingSentNoGuid(db: AppDatabase, tempGuid: string): Promise<void> {
  await withDbTransaction(db, async () => {
    // Never downgrade a row the server already told us FAILED. With the RCS bridge's immediate
    // "sending" ack, a genuine send failure (`message-send-error`) can land just BEFORE this
    // success ack; promoting to 'sent' would clobber it and hide the failure. 'error' is sticky —
    // leave the errored row (and its retry-queue entry) exactly as reconcileOutgoingError set them.
    //
    // The guard is IN the write: as a separate SELECT it answered for an instant that had already
    // passed by the time the UPDATE ran, so an error frame landing between the two was overwritten
    // and the message showed as sent with no error badge and no retry row — silently never
    // delivered. Same shape as `retireOutgoing` / `markOutgoingSending`.
    const promoted = await db.all<{ id: number }>(sql`
      UPDATE messages SET send_state = 'sent', error = 0
       WHERE guid = ${tempGuid} AND (send_state IS NULL OR send_state <> 'error')
      RETURNING id`);
    if (promoted.length > 0) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return;
    }
    // Nothing matched: either the row is stickily 'error' (leave its ladder alone) or there is no
    // message at all — and an ack for a message that no longer exists must still clear the queue
    // row, or that orphan re-sends blind on every later drain.
    const cur = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${tempGuid} LIMIT 1`,
    );
    if (cur.length === 0)
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

/** The minimal echo fields reconcileEchoByContent needs to correlate to an optimistic row. */
export interface EchoMatchFields {
  guid: string;
  isFromMe?: boolean | null;
  text?: string | null;
  dateCreated?: number | null;
  associatedMessageGuid?: string | null;
  associatedMessageType?: string | null;
}

/** Only match a temp row sent within this window of the echo's own timestamp, so a
 *  coincidentally-identical message from ANOTHER device can't hijack an unrelated stale row. */
const ECHO_MATCH_WINDOW_MS = 5 * 60_000;

/**
 * Reconcile the LIVE echo of one of OUR sent messages against its optimistic temp row.
 *
 * Gator's `new-message` is a chat.db ROWID-watcher emission and carries NO tempGuid (unlike
 * the upstream app, which correlates it in its message manager) — so we cannot match by
 * tempGuid. Instead, an incoming is-from-me message with a REAL guid is matched by CONTENT to
 * a still-pending `temp-…` row in the same chat (same text / reaction / attachment) and that
 * row is promoted IN PLACE to the real guid. The caller's subsequent upsert then UPDATEs the
 * same row (preserving its id, attachments + local_path) instead of inserting a duplicate; the
 * queue row is dropped. No-op if the real guid already exists (already reconciled by the HTTP
 * ack) or nothing matches.
 *
 * MUST be called ONLY on the live realtime echo path (DbEventSink), never the full/incremental
 * SYNC path: sync replays historical sent messages, and content-matching a brand-new optimistic
 * send to an OLD identical message would corrupt its identity. The retry/ack path reconciles
 * sync/offline sends by guid instead.
 */
export async function reconcileEchoByContent(
  db: AppDatabase,
  m: EchoMatchFields,
  chatId: number,
): Promise<void> {
  if (!m.isFromMe || m.guid.startsWith('temp-')) return;
  // Already reconciled (the HTTP ack promoted the temp row first) → leave it to the upsert.
  const already = await db.all<{ id: number }>(
    sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
  );
  if (already[0]) return;
  // Match on the fields the BARE socket echo reliably carries — serializeMessage emits NO
  // has_attachments/attachments on the live event, so we must NOT gate on them. A reaction
  // matches its target+type; everything else matches exact text. This covers attachments too:
  // an outgoing attachment send and its echo both have null text. (Attachments are always sent
  // via the Private API — the AppleScript fallback is plain-text only — so on the ack-less
  // no-guid path only TEXT arrives here, and text matches reliably; an attachment that races
  // its ack falls back to reconcileOutgoingSuccess's dup-branch local_path carry-over.)
  const match =
    m.associatedMessageType != null
      ? sql`associated_message_type = ${m.associatedMessageType} AND associated_message_guid IS ${m.associatedMessageGuid ?? null}`
      : sql`associated_message_type IS NULL AND text IS ${m.text ?? null}`;
  // Time-bound the match to a send near the echo's own timestamp (defeats a cross-device
  // identical-content hijack of an unrelated stale row).
  const echoDate = m.dateCreated ?? null;
  const window =
    echoDate != null
      ? sql`AND date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
      : sql``;
  // A LIVE row wins over a TOMBSTONED one (`date_deleted IS NULL` first). A cancelled send keeps
  // its row so this promote can carry the tombstone onto the real guid — but if the user then
  // re-sends the same words, both rows match this echo by content, and promoting the cancelled one
  // would hide the message they actually sent while leaving the visible bubble stuck on its temp
  // identity. The tombstoned row is still reachable: it is the only candidate left once the live
  // one has been promoted, which is exactly when its own echo arrives.
  // Then prefer an actually-in-flight 'sending' row, then oldest-first (the first echo corresponds
  // to the first send) so rapid identical sends promote in order, not swapped.
  // 'error' rows are matchable too: a send that FAILED client-side (502/timeout) may still have
  // gone through server-side — its echo must promote the errored bubble in place (clearing the
  // queue row, which stops the retry ladder) instead of inserting a duplicate. The ±window +
  // exact-content + same-chat guards bound stale-row hijack.
  const rows = await db.all<{ guid: string }>(sql`
    SELECT guid FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 1 AND guid LIKE 'temp-%'
      AND send_state IN ('sending', 'sent', 'error') AND ${match} ${window}
    ORDER BY (date_deleted IS NULL) DESC, (send_state = 'sending') DESC, date_created ASC, id ASC
    LIMIT 1`);
  const temp = rows[0];
  if (!temp) return;
  // Drop the queue row BEFORE promoting, so a concurrent retry tick in the gap can't claim and
  // re-POST a send that's already being reconciled.
  await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
  await db
    .update(messages)
    .set({ guid: m.guid, sendState: 'sent', error: 0 })
    .where(eq(messages.guid, temp.guid));
}

/**
 * Reconcile the SYNC materialization of one of OUR sent ATTACHMENT messages against its optimistic
 * temp row — the sync-safe sibling of {@link reconcileEchoByContent}.
 *
 * Why a SEPARATE helper (and not just calling reconcileEchoByContent on the sync path): RCS messages
 * carry NO server rowid, so the real `rcs-<id>` row is usually first materialized by a SYNC read —
 * `syncChatMessages` (thread re-open / pull-to-refresh) or `syncAllChats`'s lastMessage upsert
 * (reconnect) — NOT the live socket echo. Those sync paths never call reconcileEchoByContent, so the
 * optimistic picture's MESSAGE row is never promoted in place; upsertAttachments (keyed by
 * message_id) then can't find the temp `-att` under the new real row and inserts the server
 * attachment with a NULL local_path — a second, image-less bubble, while the on-disk image is
 * stranded on an orphaned temp duplicate. Promoting the temp row HERE, before upsertMessages, lets
 * the existing per-message-id local_path carry-over (see upsertAttachments) preserve the image.
 *
 * reconcileEchoByContent is deliberately BANNED on the sync path because it would content-match a
 * fresh optimistic TEXT send to an OLD identical historical message. This helper is sync-safe: it
 * only ever matches a still-pending optimistic send that STILL OWNS a `-att` attachment with a
 * non-null local_path — a historical re-sync has no such pending row, so it can't be hijacked; the
 * ±window additionally rejects an old identical picture surfaced by a history backfill. It is inert
 * for iMessage/SMS (their temp row is already promoted in place by the real-guid ack, so no pending
 * `temp-…` `-att` exists at sync time) and for received messages (not is-from-me).
 */
export async function reconcileOutgoingAttachmentByContent(
  db: AppDatabase,
  m: EchoMatchFields,
  chatId: number,
): Promise<void> {
  if (!m.isFromMe || m.guid.startsWith('temp-')) return;
  // Already materialized (a prior sync/echo created it) → leave it to the upsert.
  const already = await db.all<{ id: number }>(
    sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
  );
  if (already[0]) return;
  // Time-bound to a send near the echo's own timestamp (same window as reconcileEchoByContent) so a
  // history re-sync of an OLD identical picture can't claim a fresh optimistic row.
  const echoDate = m.dateCreated ?? null;
  const window =
    echoDate != null
      ? sql`AND mm.date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND mm.date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
      : sql``;
  // Match a pending optimistic outgoing message that STILL OWNS a local (on-disk) attachment — that
  // pending-local-`-att` gate is what makes this sync-safe. Match text too (a caption-less picture
  // and its echo both carry NULL text) so a text send can never claim a picture row. Prefer an
  // in-flight 'sending' row, then oldest-first, so rapid identical sends promote in send order.
  // 'error' included for the same reason as reconcileEchoByContent: a client-side-failed picture
  // whose upload actually landed must be promoted (and its queue row cleared), not duplicated.
  const rows = await db.all<{ guid: string }>(sql`
    SELECT mm.guid FROM messages mm
    WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 1 AND mm.guid LIKE 'temp-%'
      AND mm.send_state IN ('sending', 'sent', 'error')
      AND mm.associated_message_type IS NULL AND mm.text IS ${m.text ?? null}
      AND EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.message_id = mm.id AND a.guid LIKE '%-att' AND a.local_path IS NOT NULL
      )
      ${window}
    ORDER BY (mm.date_deleted IS NULL) DESC, (mm.send_state = 'sending') DESC,
             mm.date_created ASC, mm.id ASC LIMIT 1`);
  const temp = rows[0];
  if (!temp) return;
  // Drop the queue row before promoting (a no-op for the RCS case — markOutgoingSentNoGuid already
  // dropped it — but keeps a concurrent retry tick from re-POSTing a send being reconciled).
  await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
  await db
    .update(messages)
    .set({ guid: m.guid, sendState: 'sent', error: 0 })
    .where(eq(messages.guid, temp.guid));
}

/**
 * Flip an errored optimistic row back to 'sending' at the start of a deliberate queue retry.
 * Guarded to 'error' rows only, so a row already promoted to 'sent' is never regressed.
 *
 * Why this exists: the guid-less ack paths (RCS tempGuid echo → `reconcileOutgoingSuccess`'s
 * backstop, and the AppleScript fallback) reconcile via `markOutgoingSentNoGuid`, whose
 * sticky-error guard refuses to touch an 'error' row — correct for its original race (a
 * server-pushed failure landing just before the ack of the SAME attempt), but it also
 * swallowed the SUCCESS of a queue RETRY: the bubble stayed errored, the queue row survived
 * with attempts un-bumped, and the queue re-sent the same message on every later drain
 * (duplicate texts once the server's idempotency TTL lapsed). Flipping to 'sending' first
 * scopes the sticky guard back to failures reported DURING the in-flight attempt.
 */
export async function markOutgoingSending(db: AppDatabase, tempGuid: string): Promise<void> {
  await db
    .update(messages)
    .set({ sendState: 'sending', error: 0 })
    .where(and(eq(messages.guid, tempGuid), eq(messages.sendState, 'error')));
}

/**
 * Permanently retire a queue row (no further automatic retries): attempts jumps to the cap and
 * the bubble is forced to 'error' unless it already reconciled to 'sent'. For failures no retry
 * can ever fix — the attachment's on-disk file is gone, or the row's kind is unknown. The queue
 * row is KEPT, matching the natural attempts-cap retirement (the bubble's 'error' state is what
 * makes it cancellable, and `cancelOutgoing` removes the ladder along with it either way).
 */
export async function retireOutgoing(
  db: AppDatabase,
  tempGuid: string,
  errorCode = 1,
): Promise<void> {
  await db
    .update(outgoingQueue)
    .set({ attempts: OUTGOING_MAX_ATTEMPTS })
    .where(eq(outgoingQueue.tempGuid, tempGuid));
  await db
    .update(messages)
    .set({ sendState: 'error', error: errorCode })
    .where(and(eq(messages.guid, tempGuid), ne(messages.sendState, 'sent')));
}

/** Max automatic retries before a queued send retires to the 'error' bubble. */
export const OUTGOING_MAX_ATTEMPTS = 5;
// A freshly-inserted row is assumed in-flight (the UI send owns it) for this long, so
// the retry processor won't double-send it; past this, an un-deleted row is stranded.
const OUTGOING_GRACE_MS = 60_000;
// Lease set on a row while a retry attempt is in flight (prevents concurrent runners).
const OUTGOING_LEASE_MS = 120_000;

/** Exponential backoff for retry N (1-based): 30s, 60s, 120s, 240s, 480s — capped at 1h. */
export function outgoingBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

/**
 * Reconcile a failed send: mark the temp message errored, bump attempts, schedule a backoff retry.
 *
 * Returns whether this call actually OWNED a queue row — i.e. whether the retry ladder was really
 * advanced. Callers that have a fallback (see {@link applyServerSendError}) must branch on this
 * rather than on a preceding "is there a queue row?" SELECT: the ack that deletes the row can land
 * between such a read and this write, and then the ladder silently goes nowhere.
 *
 * The attempts bump is a compare-and-set on the value we read (`AND attempts = <read>`), so a
 * concurrent bump/retire wins outright and is reported as "not owned" instead of being clobbered.
 */
export async function reconcileOutgoingError(
  db: AppDatabase,
  tempGuid: string,
  errorCode: number,
  now: number = Date.now(),
): Promise<boolean> {
  await db
    .update(messages)
    .set({ sendState: 'error', error: errorCode })
    .where(eq(messages.guid, tempGuid));
  const cur = await db.all<{ attempts: number }>(
    sql`SELECT attempts FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`,
  );
  const prior = cur[0]?.attempts;
  if (prior == null) return false;
  const attempts = prior + 1;
  const bumped = await db.all<{ id: number }>(sql`
    UPDATE outgoing_queue SET attempts = ${attempts}, next_retry_at = ${now + outgoingBackoffMs(attempts)}
     WHERE temp_guid = ${tempGuid} AND attempts = ${prior}
    RETURNING id`);
  return bumped.length > 0;
}

/**
 * Flip a message to the error state from a SERVER-pushed `message-send-error` (Messages.app
 * rejected the send after it already left the app). Unlike {@link reconcileOutgoingError} this does
 * NOT touch the outgoing_queue — it only surfaces the failure on the bubble (error badge + retry).
 * No-op if the guid doesn't match a local message.
 */
export async function markMessageSendError(
  db: AppDatabase,
  guid: string,
  errorCode = 1,
): Promise<void> {
  await db
    .update(messages)
    .set({ sendState: 'error', error: errorCode })
    .where(eq(messages.guid, guid));
}

/**
 * Re-enqueue cycle cap. The RCS immediate-ack flow can loop forever on a permanently-failing
 * send: ack marks the bubble 'sent' + deletes the queue row → the async failure re-enqueues →
 * the retry is acked again → fails async again → … Nothing durable survives each cycle (the
 * ack resets both the queue row and the message's error field), so the cap lives here: at most
 * MAX_REQUEUE_CYCLES automatic ladders per tempGuid per app session; after that the failure
 * stays on the bubble for a manual retry. Bounded like {@link cancelledTempGuids}.
 */
const requeueCycles = new Map<string, number>();
const MAX_REQUEUE_CYCLES = 2;
const REQUEUE_MAP_MAX = 256;

/**
 * Re-arm the automatic retry ladder for a send whose failure arrived AFTER its ack — the RCS
 * immediate-ack contract: the server acks instantly, relays to Google in the background, and
 * reports a send-phase failure via `message-send-error` with `retryable: true`. By then the ack
 * already deleted the queue row, so without this the "picture failed after the ack" case was
 * manual-retry only. Rebuilds a queue row from the message (+ attachment) rows.
 *
 * Returns false (caller falls back to bubble-only error) when: the guid isn't a temp- row
 * anymore (promoted rows can't be re-sent), it's a reaction (never flagged retryable by the
 * server), the message is TOMBSTONED (the user cancelled/deleted it — rebuilding a ladder would
 * re-send behind their back the very thing they removed), a queue row already exists, the cycle cap
 * is spent, or an attachment's on-disk file reference is gone.
 */
export async function reEnqueueOutgoingFromMessage(
  db: AppDatabase,
  tempGuid: string,
  now: number,
): Promise<boolean> {
  if (!tempGuid.startsWith('temp-')) return false;
  if ((requeueCycles.get(tempGuid) ?? 0) >= MAX_REQUEUE_CYCLES) return false;
  const rows = await db.all<{
    id: number;
    text: string | null;
    subject: string | null;
    threadOriginatorGuid: string | null;
    expressiveSendStyleId: string | null;
    chatGuid: string | null;
  }>(sql`
    SELECT m.id, m.text, m.subject,
           m.thread_originator_guid AS threadOriginatorGuid,
           m.expressive_send_style_id AS expressiveSendStyleId,
           c.guid AS chatGuid
    FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE m.guid = ${tempGuid} AND m.associated_message_type IS NULL
      AND m.date_deleted IS NULL LIMIT 1`);
  const msg = rows[0];
  if (!msg?.chatGuid) return false;
  const queued = await db.all<{ id: number }>(
    sql`SELECT id FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`,
  );
  if (queued[0]) return false; // a live ladder already owns it — bump, don't duplicate
  const att = await db.all<{ guid: string; localPath: string | null }>(sql`
    SELECT guid, local_path AS localPath FROM attachments
    WHERE message_id = ${msg.id} AND guid LIKE '%-att' LIMIT 1`);
  let kind: 'text' | 'attachment';
  let payload: string;
  const firstAtt = att[0];
  if (firstAtt) {
    if (!firstAtt.localPath) return false; // nothing on disk to re-upload
    kind = 'attachment';
    payload = JSON.stringify({ attachmentGuid: firstAtt.guid, localPath: firstAtt.localPath });
  } else {
    kind = 'text';
    payload = JSON.stringify({
      message: msg.text ?? '',
      selectedMessageGuid: msg.threadOriginatorGuid ?? undefined,
      effectId: msg.expressiveSendStyleId ?? undefined,
      subject: msg.subject ?? undefined,
    });
  }
  // attempts starts at 1: the failed background relay WAS attempt one, and attempts>=1 also
  // bypasses the fresh-row grace window so the ladder re-fires on the next drain tick.
  await db.insert(outgoingQueue).values({
    tempGuid,
    chatGuid: msg.chatGuid,
    kind,
    payload,
    attempts: 1,
    nextRetryAt: now + outgoingBackoffMs(1),
  });
  if (requeueCycles.size >= REQUEUE_MAP_MAX) {
    const oldest = requeueCycles.keys().next().value;
    if (oldest !== undefined) requeueCycles.delete(oldest);
  }
  requeueCycles.set(tempGuid, (requeueCycles.get(tempGuid) ?? 0) + 1);
  return true;
}

/**
 * Apply a SERVER-pushed `message-send-error` with retry-ladder awareness. If the guid still has
 * an outgoing_queue row (an optimistic send the app owns — e.g. the RCS bridge failed FAST,
 * before/around the immediate ack), route through {@link reconcileOutgoingError} so attempts is
 * bumped and the backoff rescheduled — without this, a fast async failure left attempts at 0/1
 * forever and the ladder never converged. When the queue row is already gone (the RCS
 * immediate-ack consumed it) and the server flagged the failure `retryable` (send-phase:
 * nothing reached Google, so a re-send cannot duplicate), re-enqueue a fresh ladder via
 * {@link reEnqueueOutgoingFromMessage}. In every case the bubble is flipped to the error state;
 * a re-enqueued ladder clears it again on success.
 */
export async function applyServerSendError(
  db: AppDatabase,
  guid: string,
  errorCode = 1,
  now: number = Date.now(),
  retryable = false,
): Promise<void> {
  // The bump IS the "is a ladder still alive?" test. Asking first with a SELECT and then
  // committing to that branch lost the whole retryable path when the ack deleted the queue row in
  // between (three awaits wide): the UPDATE matched nothing, reported nothing, and the re-enqueue
  // below was never reached — the one case this machinery exists for, downgraded to bubble-only.
  if (await reconcileOutgoingError(db, guid, errorCode, now)) return;
  if (retryable) await reEnqueueOutgoingFromMessage(db, guid, now);
  await markMessageSendError(db, guid, errorCode);
}

export interface RetryableOutgoing {
  id: number;
  tempGuid: string;
  chatGuid: string;
  kind: string;
  payload: string;
  attempts: number;
  createdAt: number;
}

/**
 * Rows eligible for an automatic retry: under the attempt cap, their backoff has
 * elapsed, and they're either already-failed (attempts ≥ 1) or stranded past the
 * in-flight grace window (a UI send that never completed — e.g. a crash mid-send).
 */
export async function listRetryableOutgoing(
  db: AppDatabase,
  now: number,
): Promise<RetryableOutgoing[]> {
  return db.all<RetryableOutgoing>(sql`
    SELECT id, temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts, created_at AS createdAt
    FROM outgoing_queue
    WHERE attempts < ${OUTGOING_MAX_ATTEMPTS}
      AND next_retry_at <= ${now}
      AND (attempts >= 1 OR created_at <= ${now - OUTGOING_GRACE_MS})
    ORDER BY created_at ASC`);
}

/**
 * Atomically lease a row for a retry attempt by pushing next_retry_at into the future.
 * Exactly one caller wins (the `next_retry_at <= now` guard); the rest get false and
 * skip — the real lock against two concurrent processors (a useRef wouldn't suffice).
 */
export async function claimOutgoing(db: AppDatabase, id: number, now: number): Promise<boolean> {
  const rows = await db.all<{ id: number }>(sql`
    UPDATE outgoing_queue SET next_retry_at = ${now + OUTGOING_LEASE_MS}
    WHERE id = ${id} AND next_retry_at <= ${now} RETURNING id`);
  return rows.length > 0;
}

/** Halves of an optimistic send that lost their partner (see {@link countOutgoingQueueHealth}). */
export interface OutgoingQueueHealth {
  /**
   * Optimistic bubbles frozen on 'sending' with NO queue row to recover them. Nothing retries
   * these and nothing resets them at boot, so each one is a message the user believes is on its
   * way that will never be sent. TOMBSTONED rows are excluded: a cancelled send deliberately keeps
   * its 'sending' state (so the echo can still promote it) and its ladder is gone on purpose, so
   * counting it would report a permanent, self-inflicted "stranded" every launch.
   */
  strandedSending: number;
  /**
   * Queue rows whose optimistic message is gone. Each will be re-sent blind on the next drain,
   * with no bubble anywhere to show for it — including a send the user explicitly cancelled.
   */
  orphanQueueRows: number;
}

/**
 * Count the two halves of the optimistic-send lifecycle that can be left without their partner if
 * the process dies between two of its adjacent commits. Both are supposed to be impossible now
 * (every insert/reconcile/discard commits the pair in one transaction) — this is the cheap
 * standing check that says whether that's actually true on real devices, since the windows are far
 * too small to reproduce deliberately. Log at warn only when non-zero.
 *
 * Both halves must stay INDEX-DRIVEN: this is awaited ahead of the boot drain, and `messages` is
 * the biggest table on the device. `guid LIKE 'temp-%'` cannot use `messages_guid_idx` — SQLite's
 * LIKE optimization is off under the default case-insensitive LIKE — and plans as a full scan of
 * every synced message. The half-open RANGE below is the same set of guids (they are minted
 * lowercase by `generateTempGuid`; '.' is the next byte after '-') and plans as an index search.
 */
export async function countOutgoingQueueHealth(db: AppDatabase): Promise<OutgoingQueueHealth> {
  const rows = await db.all<OutgoingQueueHealth>(sql`
    SELECT
      (SELECT COUNT(*) FROM messages m
        WHERE m.guid >= 'temp-' AND m.guid < 'temp.' AND m.send_state = 'sending'
          AND m.date_deleted IS NULL
          AND NOT EXISTS (SELECT 1 FROM outgoing_queue q WHERE q.temp_guid = m.guid)
      ) AS strandedSending,
      (SELECT COUNT(*) FROM outgoing_queue q
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.guid = q.temp_guid)
      ) AS orphanQueueRows`);
  return rows[0] ?? { strandedSending: 0, orphanQueueRows: 0 };
}
