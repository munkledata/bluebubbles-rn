/**
 * Opt-in host proxy for the non-cold inbox path. It uses production SQL, useChats,
 * and ConversationTile, but React Native's Jest renderer is not a native frame or
 * FlashList measurement. With Node 24 active, run:
 * GATOR_INBOX_REACTIVE_BENCHMARK=1 node --expose-gc node_modules/jest/bin/jest.js \
 *   --runInBand --selectProjects=components --runTestsByPath \
 *   test/components/performance/inboxReactiveBenchmark.test.tsx
 */
import React, { useLayoutEffect } from 'react';
import { act, renderWithTheme, waitFor } from '../support/renderWithTheme';
import { listChatsForInboxPage, type InboxRow } from '@db/repositories';
import {
  useChats,
  type InboxQuerySource,
  type InboxQueryTiming,
} from '@features/conversations/useChats';
import { ConversationTile } from '@ui/conversations/ConversationTile';
import { createTestDb } from '../../support/testDb';

jest.mock('@/services', () => ({
  deleteChat: jest.fn(),
  markRead: jest.fn(),
  markUnread: jest.fn(),
  setChatArchived: jest.fn(),
  setChatMuted: jest.fn(),
}));

const benchmark = process.env.GATOR_INBOX_REACTIVE_BENCHMARK === '1' ? test : test.skip;
const CHAT_COUNTS = [1_000, 10_000] as const;
const MESSAGES_PER_CHAT = 4;
const WRITE_COUNT = 80;
const WRITE_INTERVAL_MS = 40;
const PAGE_SIZE = 50;
const MAX_RETAINED_ROWS = 200;
const VISIBLE_ROWS = 20;
const ignorePress = (): void => undefined;

type Fixture = Awaited<ReturnType<typeof createTestDb>>;
type Memory = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>;

function sampleMemory(): Memory {
  const { rss, heapUsed } = process.memoryUsage();
  return { rss, heapUsed };
}

function roundedMs(value: number): number {
  return Number(value.toFixed(3));
}

function roundedMiB(value: number): number {
  return Number((value / (1024 * 1024)).toFixed(3));
}

function memoryReport(memory: Memory): { rssMiB: number; heapMiB: number } {
  return { rssMiB: roundedMiB(memory.rss), heapMiB: roundedMiB(memory.heapUsed) };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedFixture({ raw }: Fixture, chatCount: number): void {
  const insertHandle = raw.prepare(
    "INSERT INTO handles (id, address, service, display_name) VALUES (?, ?, 'iMessage', ?)",
  );
  const insertChat = raw.prepare(
    `INSERT INTO chats
       (id, guid, chat_identifier, display_name, style, is_archived, is_pinned, latest_message_date)
     VALUES (?, ?, ?, ?, 45, ?, 0, ?)`,
  );
  const insertChatHandle = raw.prepare(
    'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
  );
  const insertMessage = raw.prepare(
    `INSERT INTO messages
       (id, guid, original_row_id, chat_id, handle_id, text, is_from_me, date_created,
        has_attachments, error, send_state)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 'sent')`,
  );
  raw.transaction(() => {
    for (let chatId = 1; chatId <= chatCount; chatId += 1) {
      const address = `benchmark-${chatId}@example.test`;
      const latest = 1_700_000_000_000 + chatId * 10 + MESSAGES_PER_CHAT;
      insertHandle.run(chatId, address, `Participant ${chatId}`);
      insertChat.run(
        chatId,
        `iMessage;-;benchmark-${chatId}`,
        address,
        `Benchmark chat ${chatId}`,
        chatId % 20 === 0 ? 1 : 0,
        latest,
      );
      insertChatHandle.run(chatId, chatId);
      for (let offset = 1; offset <= MESSAGES_PER_CHAT; offset += 1) {
        const messageId = (chatId - 1) * MESSAGES_PER_CHAT + offset;
        insertMessage.run(
          messageId,
          `benchmark-message-${messageId}`,
          messageId,
          chatId,
          chatId,
          `Benchmark message ${offset}`,
          1_700_000_000_000 + chatId * 10 + offset,
        );
      }
    }
  })();
}

interface Probe {
  readonly commits: number[];
  readonly queryToCommitMs: number[];
  readonly queryFinishedToCommitMs: number[];
  readonly pendingQueries: Map<number, InboxQueryTiming>;
  latestRows: InboxRow[];
  loadMore: (() => void) | undefined;
  maxRows: number;
}

function InboxProbe({
  source,
  onQueryTiming,
  onCommit,
}: {
  source: InboxQuerySource;
  onQueryTiming: (timing: InboxQueryTiming) => void;
  onCommit: (rows: InboxRow[], loadMore: (() => void) | undefined) => void;
}): React.JSX.Element {
  const state = useChats(false, {
    pageSize: PAGE_SIZE,
    source,
    onQueryTiming,
  });
  const rows = state.data ?? [];
  useLayoutEffect(() => {
    onCommit(rows, state.loadMore);
  });
  return (
    <>
      {rows.slice(0, VISIBLE_ROWS).map((row) => (
        <ConversationTile key={row.guid} row={row} onPress={ignorePress} readOnly />
      ))}
    </>
  );
}

async function runScale(chatCount: (typeof CHAT_COUNTS)[number]): Promise<void> {
  const fixture = await createTestDb();
  let renderer: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  try {
    seedFixture(fixture, chatCount);
    const subscribers = new Set<() => void>();
    const source: InboxQuerySource = {
      key: `host-reactive-${chatCount}`,
      query: async ({ limit, archive, sender, filters }) => {
        const page = await listChatsForInboxPage(fixture.db, {
          limit: limit ?? PAGE_SIZE,
          archive,
          sender,
          filters,
        });
        return { ...page, unknownCount: 0 };
      },
      subscribe: (_tables, onChange) => {
        subscribers.add(onChange);
        return () => void subscribers.delete(onChange);
      },
    };
    const probe: Probe = {
      commits: [],
      queryToCommitMs: [],
      queryFinishedToCommitMs: [],
      pendingQueries: new Map(),
      latestRows: [],
      loadMore: undefined,
      maxRows: 0,
    };
    const onQueryTiming = (timing: InboxQueryTiming): void => {
      if (timing.firstLatestMessageDate != null) {
        probe.pendingQueries.set(timing.firstLatestMessageDate, timing);
      }
    };
    const onCommit = (rows: InboxRow[], loadMore: (() => void) | undefined): void => {
      probe.latestRows = rows;
      probe.loadMore = loadMore;
      probe.maxRows = Math.max(probe.maxRows, rows.length);
      const date = rows[0]?.latestMessageDate;
      if (date == null) return;
      const timing = probe.pendingQueries.get(date);
      if (!timing) return;
      const committedAt = performance.now();
      probe.commits.push(committedAt);
      probe.queryToCommitMs.push(committedAt - timing.startedAtMs);
      probe.queryFinishedToCommitMs.push(committedAt - timing.finishedAtMs);
      probe.pendingQueries.delete(date);
    };
    if (typeof global.gc !== 'function') throw new Error('Run this benchmark with --expose-gc.');
    global.gc();
    const baseline = sampleMemory();
    let peak = baseline;
    const samplePeak = (): void => {
      const sample = sampleMemory();
      peak = {
        rss: Math.max(peak.rss, sample.rss),
        heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
      };
    };
    renderer = await renderWithTheme(
      <InboxProbe source={source} onQueryTiming={onQueryTiming} onCommit={onCommit} />,
    );
    await waitFor(() => expect(probe.latestRows).toHaveLength(PAGE_SIZE));
    for (let expected = PAGE_SIZE * 2; expected <= MAX_RETAINED_ROWS; expected += PAGE_SIZE) {
      await act(async () => probe.loadMore?.());
      await waitFor(() => expect(probe.latestRows).toHaveLength(expected));
    }
    expect(probe.maxRows).toBe(MAX_RETAINED_ROWS);
    expect(subscribers.size).toBe(1);
    samplePeak();

    const insertMessage = fixture.raw.prepare(
      `INSERT INTO messages
         (id, guid, original_row_id, chat_id, handle_id, text, is_from_me, date_created,
          has_attachments, error, send_state)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 'sent')`,
    );
    const bumpChat = fixture.raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = ?');
    // Every twentieth fixture chat is archived, including chatCount itself.
    const targetChatId = chatCount - 1;
    const write = fixture.raw.transaction((sequence: number) => {
      const messageId = chatCount * MESSAGES_PER_CHAT + sequence;
      const latest = 1_700_000_100_000 + sequence;
      insertMessage.run(
        messageId,
        `benchmark-arrival-${chatCount}-${sequence}`,
        messageId,
        targetChatId,
        targetChatId,
        `Arrival ${sequence}`,
        latest,
      );
      bumpChat.run(latest, targetChatId);
    });
    const beforeWrites = probe.commits.length;
    for (let sequence = 1; sequence <= WRITE_COUNT; sequence += 1) {
      await act(async () => {
        write(sequence);
        for (const notify of subscribers) notify();
        await pause(WRITE_INTERVAL_MS);
      });
      samplePeak();
    }
    await waitFor(() => expect(probe.latestRows[0]?.latestMessageDate).toBe(1_700_000_100_080));
    const commitTimes = probe.commits.slice(beforeWrites);
    const publicationGaps = commitTimes.slice(1).map((time, index) => time - commitTimes[index]!);
    const queries = probe.queryToCommitMs.slice(beforeWrites);
    const finished = probe.queryFinishedToCommitMs.slice(beforeWrites);
    samplePeak();
    await renderer.unmount();
    renderer = undefined;
    probe.latestRows = [];
    probe.loadMore = undefined;
    probe.pendingQueries.clear();
    global.gc();
    const postUnmount = sampleMemory();
    expect(subscribers.size).toBe(0);
    expect(probe.maxRows).toBeLessThanOrEqual(MAX_RETAINED_ROWS);
    expect(commitTimes.length).toBeGreaterThan(0);
    process.stdout.write(
      `${JSON.stringify({
        artifact: 'PERF-01-host-reactive-render-proxy',
        fixture: {
          chats: chatCount,
          messagesPerChat: MESSAGES_PER_CHAT,
          loadedRows: MAX_RETAINED_ROWS,
          renderedRows: VISIBLE_ROWS,
        },
        sustained: {
          writes: WRITE_COUNT,
          intervalMs: WRITE_INTERVAL_MS,
          commits: commitTimes.length,
          maxPublicationGapMs: roundedMs(Math.max(0, ...publicationGaps)),
          maxQueryToCommitMs: roundedMs(Math.max(0, ...queries)),
          maxQueryFinishedToCommitMs: roundedMs(Math.max(0, ...finished)),
          maxRetainedRows: probe.maxRows,
        },
        memory: {
          baseline: memoryReport(baseline),
          peak: memoryReport(peak),
          postUnmount: memoryReport(postUnmount),
        },
        caveat: 'Jest React commit proxy, not Android native drawing or a cold start',
      })}\n`,
    );
  } finally {
    await renderer?.unmount();
    fixture.raw.close();
  }
}

benchmark(
  'keeps the real inbox subscription and row-render proxy bounded at 1k and 10k',
  async () => {
    for (const chatCount of CHAT_COUNTS) await runScale(chatCount);
  },
  300_000,
);
