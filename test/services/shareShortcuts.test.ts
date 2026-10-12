import type { InboxRow } from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

const native = {
  clearLegacyShareShortcuts: jest.fn(),
  // Native keeps this alias for already-shipped cleanup callers; current JS uses the explicit API.
  clearShareShortcuts: jest.fn(),
  clearCurrentShareShortcuts: jest.fn(),
  clearAllShareShortcuts: jest.fn(),
  setShareShortcuts: jest.fn(),
  resolveShareShortcutTarget: jest.fn(),
  reportShareShortcutUsed: jest.fn(),
};
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

jest.mock('@core/secure', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('@db/database', () => ({
  getDatabase: jest.fn(),
}));

jest.mock('@db/repositories', () => ({
  listChatsForInboxPage: jest.fn(),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: jest.fn(),
  runTrackedRealtimeWork: jest.fn(),
}));

// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { listChatsForInboxPage } from '@db/repositories';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import {
  clearAllShareShortcuts,
  clearCurrentShareShortcuts,
  clearShareShortcuts,
  publishShareShortcuts,
  refreshShareShortcuts,
  resolveShareShortcutTarget,
} from '@/services/shortcuts/shareShortcuts';

const getDb = getDatabase as jest.MockedFunction<typeof getDatabase>;
const listInbox = listChatsForInboxPage as jest.MockedFunction<typeof listChatsForInboxPage>;
const captureLease = captureRealtimeDeliveryLease as jest.MockedFunction<
  typeof captureRealtimeDeliveryLease
>;
const runTracked = runTrackedRealtimeWork as jest.MockedFunction<typeof runTrackedRealtimeWork>;
const warn = logger.warn as jest.MockedFunction<typeof logger.warn>;

const database = { name: 'share-shortcut-test-db' };
const TARGET_TOKEN = `gator-share-v2-${'A'.repeat(43)}`;

function lease(isCurrent: () => boolean = () => true): RealtimeDeliveryLease {
  return { generation: 7, isCurrent };
}

function inboxRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15550000001',
    chatIdentifier: '+15550000001',
    displayName: 'Alice',
    customName: null,
    customColor: null,
    style: 45,
    isPinned: 0,
    pinOrder: null,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1,
    lastReadMessageGuid: null,
    lastText: null,
    lastSubject: null,
    lastIsFromMe: null,
    lastHasAttachments: null,
    lastDate: null,
    lastGuid: null,
    lastAssociatedType: null,
    lastError: null,
    participantCount: 1,
    participantNames: '["Alice"]',
    participantAvatars: '[null]',
    handleServices: 'iMessage',
    unreadCount: 0,
    hasKnownSender: 1,
    ...overrides,
  };
}

function setVisibleRows(rows: InboxRow[]): void {
  listInbox.mockImplementation(async (_db, options) => {
    const limit = options?.limit ?? rows.length;
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  });
}

function manyRows(count: number): InboxRow[] {
  return Array.from({ length: count }, (_, index) =>
    inboxRow({
      id: index + 1,
      guid: `iMessage;-;+15550000${String(index).padStart(3, '0')}`,
      displayName: `Person ${index}`,
    }),
  );
}

beforeEach(() => {
  moduleRef.current = native;
  // Account cleanup also forgets what was last published, so each test starts unpublished.
  clearCurrentShareShortcuts();
  Object.values(native).forEach((method) => method.mockReset());
  getDb.mockReset().mockReturnValue(database as never);
  listInbox.mockReset();
  captureLease.mockReset().mockReturnValue(lease());
  runTracked.mockReset().mockImplementation(async (activeLease, task) => {
    if (!activeLease.isCurrent()) return 'paused';
    await task(activeLease);
    return 'delivered';
  });
  warn.mockReset();
});

describe('Direct Share shortcut mutation bridge', () => {
  it('maps the public compatibility cleanup name to the explicit legacy-only native API', () => {
    expect(clearShareShortcuts()).toBe(true);

    expect(native.clearLegacyShareShortcuts).toHaveBeenCalledTimes(1);
    expect(native.clearShareShortcuts).not.toHaveBeenCalled();
    const revision = native.clearLegacyShareShortcuts.mock.calls[0]?.[0] as number;
    expect(Number.isSafeInteger(revision)).toBe(true);
    expect(revision).toBeGreaterThan(0);
  });

  it('uses distinct current-account and all-account cleanup APIs with increasing revisions', () => {
    expect(clearCurrentShareShortcuts()).toBe(true);
    expect(clearAllShareShortcuts()).toBe(true);

    const currentRevision = native.clearCurrentShareShortcuts.mock.calls[0]?.[0] as number;
    const allRevision = native.clearAllShareShortcuts.mock.calls[0]?.[0] as number;
    expect(Number.isSafeInteger(currentRevision)).toBe(true);
    expect(Number.isSafeInteger(allRevision)).toBe(true);
    expect(currentRevision).toBeLessThan(allRevision);
  });

  it('publishes only ten rows with bounded, resolved labels and the App Lock policy flag', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      inboxRow({
        id: index + 1,
        guid: `iMessage;-;+15550000${String(index).padStart(3, '0')}`,
        displayName: index === 0 ? `  ${'A'.repeat(100)}  ` : `Person ${index}`,
      }),
    );

    expect(publishShareShortcuts(rows, true)).toBe(true);

    const [revision, records, appLockEnabled] = native.setShareShortcuts.mock.calls[0] as [
      number,
      { guid: string; label: string }[],
      boolean,
    ];
    expect(Number.isSafeInteger(revision)).toBe(true);
    expect(records).toHaveLength(10);
    expect(records[0]).toEqual({ guid: rows[0]!.guid, label: 'A'.repeat(80) });
    expect(records[9]).toEqual({ guid: rows[9]!.guid, label: 'Person 9' });
    expect(appLockEnabled).toBe(true);
  });

  it('refreshes from the canonical unfiltered resolver universe before publishing', async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      inboxRow({
        id: index + 1,
        guid: `iMessage;-;+15550000${String(index).padStart(3, '0')}`,
        displayName: `Canonical ${index}`,
      }),
    );
    setVisibleRows(rows);

    await expect(refreshShareShortcuts(false, lease())).resolves.toBe(true);

    expect(runTracked).toHaveBeenCalledTimes(1);
    // The same ordered active-chat list the resolver uses, read only as far as publishing needs.
    expect(listInbox).toHaveBeenCalledWith(database, { limit: 10, archive: 'active' });
    expect(native.setShareShortcuts).toHaveBeenCalledWith(
      expect.any(Number),
      rows.slice(0, 10).map((row) => ({ guid: row.guid, label: row.displayName })),
      false,
    );
  });

  it('skips the native publish while the shortcuts have not changed', async () => {
    // Every inbox update used to re-run keystore signing and ShortcutManager calls on the JS thread.
    const rows = manyRows(12);
    expect(publishShareShortcuts(rows, false)).toBe(true);
    expect(
      publishShareShortcuts(
        rows.map((row) => ({ ...row })),
        false,
      ),
    ).toBe(true);
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);

    publishShareShortcuts([{ ...rows[0]!, displayName: 'Renamed' }, ...rows.slice(1)], false);
    publishShareShortcuts(rows, true);
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(3);

    clearCurrentShareShortcuts();
    publishShareShortcuts(rows, true);
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(4);
  });

  it('retries a publish the native module refused', () => {
    native.setShareShortcuts.mockImplementationOnce(() => {
      throw new TypeError('rate limited');
    });
    expect(publishShareShortcuts([inboxRow()], false)).toBe(false);
    expect(publishShareShortcuts([inboxRow()], false)).toBe(true);
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(2);
  });

  it('clears personalized rows for App Lock without reading the account inbox', async () => {
    await expect(refreshShareShortcuts(true, lease())).resolves.toBe(true);

    expect(listInbox).not.toHaveBeenCalled();
    expect(native.setShareShortcuts).toHaveBeenCalledWith(expect.any(Number), [], true);
  });

  it.each([
    ['legacy cleanup', clearShareShortcuts, native.clearLegacyShareShortcuts],
    ['current cleanup', clearCurrentShareShortcuts, native.clearCurrentShareShortcuts],
    ['account cleanup', clearAllShareShortcuts, native.clearAllShareShortcuts],
    ['publish', () => publishShareShortcuts([inboxRow()], false), native.setShareShortcuts],
  ])(
    'returns false and logs a content-free error when %s throws',
    (operation, invoke, nativeMethod) => {
      nativeMethod.mockImplementationOnce(() => {
        throw new TypeError('private Android detail');
      });

      expect(invoke()).toBe(false);
      expect(warn).toHaveBeenCalledWith(`[shortcuts] ${operation} failed`, {
        errorName: 'TypeError',
      });
    },
  );

  it('is a safe no-op when the optional shortcut module is absent', () => {
    moduleRef.current = null;

    expect(clearShareShortcuts()).toBe(false);
    expect(clearCurrentShareShortcuts()).toBe(false);
    expect(clearAllShareShortcuts()).toBe(false);
    expect(publishShareShortcuts([inboxRow()], false)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Direct Share target resolution', () => {
  it('captures the current account generation when the caller does not provide a lease', async () => {
    const row = inboxRow();
    setVisibleRows([row]);
    native.resolveShareShortcutTarget.mockReturnValue(row.guid);

    await expect(resolveShareShortcutTarget(TARGET_TOKEN)).resolves.toBe(row.guid);

    expect(captureLease).toHaveBeenCalledTimes(1);
    expect(native.reportShareShortcutUsed).toHaveBeenCalledWith(TARGET_TOKEN);
  });

  it('resolves only through the bounded visible-chat candidate set and reports successful use', async () => {
    const row = inboxRow();
    setVisibleRows([row]);
    native.resolveShareShortcutTarget.mockReturnValue(row.guid);

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBe(row.guid);

    expect(getDb).toHaveBeenCalledTimes(1);
    expect(listInbox).toHaveBeenCalledWith(database, { limit: 10, archive: 'active' });
    expect(native.resolveShareShortcutTarget).toHaveBeenCalledWith(TARGET_TOKEN, [row.guid]);
    expect(native.reportShareShortcutUsed).toHaveBeenCalledWith(TARGET_TOKEN);
  });

  it('resolves a published shortcut against only the ten chats it could name', async () => {
    // Each candidate costs one hardware-keystore HMAC on the JS thread; 256 froze the app.
    const rows = manyRows(40);
    setVisibleRows(rows);
    native.resolveShareShortcutTarget.mockImplementation((_token, candidates: string[]) =>
      candidates.includes(rows[3]!.guid) ? rows[3]!.guid : null,
    );

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBe(rows[3]!.guid);

    expect(native.resolveShareShortcutTarget).toHaveBeenCalledTimes(1);
    expect(native.resolveShareShortcutTarget).toHaveBeenCalledWith(
      TARGET_TOKEN,
      rows.slice(0, 10).map((row) => row.guid),
    );
  });

  it('falls back to the rest of the active chats when the target has moved down', async () => {
    const rows = manyRows(40);
    setVisibleRows(rows);
    native.resolveShareShortcutTarget.mockImplementation((_token, candidates: string[]) =>
      candidates.includes(rows[25]!.guid) ? rows[25]!.guid : null,
    );

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBe(rows[25]!.guid);

    expect(native.resolveShareShortcutTarget).toHaveBeenCalledTimes(2);
    expect(native.resolveShareShortcutTarget).toHaveBeenLastCalledWith(
      TARGET_TOKEN,
      rows.slice(10).map((row) => row.guid),
    );
    expect(listInbox).toHaveBeenLastCalledWith(database, { limit: 256, archive: 'active' });
  });

  it('keeps a valid target when best-effort usage reporting fails', async () => {
    const row = inboxRow();
    setVisibleRows([row]);
    native.resolveShareShortcutTarget.mockReturnValue(row.guid);
    native.reportShareShortcutUsed.mockImplementationOnce(() => {
      throw new TypeError('private ranking detail');
    });

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBe(row.guid);
    expect(warn).toHaveBeenCalledWith('[shortcuts] usage reporting failed', {
      errorName: 'TypeError',
    });
  });

  it.each([
    ['a malformed token', 'chat-guid', lease()],
    ['a stale account lease', TARGET_TOKEN, lease(() => false)],
  ])('rejects %s before reading account data', async (_label, token, accountLease) => {
    await expect(resolveShareShortcutTarget(token, accountLease)).resolves.toBeNull();

    expect(getDb).not.toHaveBeenCalled();
    expect(listInbox).not.toHaveBeenCalled();
    expect(native.resolveShareShortcutTarget).not.toHaveBeenCalled();
  });

  it('returns generic routing when the optional native module is absent', async () => {
    moduleRef.current = null;

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBeNull();
    expect(listInbox).not.toHaveBeenCalled();
  });

  it('drops a result when the account lease is revoked during the database read', async () => {
    let current = true;
    let finishRead!: (value: { rows: InboxRow[]; hasMore: boolean }) => void;
    const row = inboxRow();
    listInbox.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }) as ReturnType<typeof listChatsForInboxPage>,
    );

    const pending = resolveShareShortcutTarget(
      TARGET_TOKEN,
      lease(() => current),
    );
    current = false;
    finishRead({ rows: [row], hasMore: false });

    await expect(pending).resolves.toBeNull();
    expect(native.resolveShareShortcutTarget).not.toHaveBeenCalled();
    expect(native.reportShareShortcutUsed).not.toHaveBeenCalled();
  });

  it('drops a native result when the account changes during resolution', async () => {
    let current = true;
    const row = inboxRow();
    setVisibleRows([row]);
    native.resolveShareShortcutTarget.mockImplementationOnce(() => {
      current = false;
      return row.guid;
    });

    await expect(
      resolveShareShortcutTarget(
        TARGET_TOKEN,
        lease(() => current),
      ),
    ).resolves.toBeNull();
    expect(native.reportShareShortcutUsed).not.toHaveBeenCalled();
  });

  it.each([null, 'iMessage;-;+19999999999'])(
    'rejects an unknown native target (%s)',
    async (resolved) => {
      const row = inboxRow();
      setVisibleRows([row]);
      native.resolveShareShortcutTarget.mockReturnValue(resolved);

      await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBeNull();
      expect(listInbox).toHaveBeenCalledTimes(1);
      expect(native.resolveShareShortcutTarget).toHaveBeenCalledTimes(1);
      expect(native.reportShareShortcutUsed).not.toHaveBeenCalled();
    },
  );

  it('contains and redacts database/native resolution failures', async () => {
    listInbox.mockRejectedValueOnce(new TypeError('private query detail'));

    await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[shortcuts] target resolution failed', {
      errorName: 'TypeError',
    });
  });
});

it('keeps shortcut identity resolution independent from conversation send capabilities', async () => {
  const row = inboxRow({ guid: 'SMS;-;+15550000001', handleServices: 'SMS' });
  setVisibleRows([row]);
  native.resolveShareShortcutTarget.mockReturnValue(row.guid);

  await expect(resolveShareShortcutTarget(TARGET_TOKEN, lease())).resolves.toBe(row.guid);
  expect(native.reportShareShortcutUsed).toHaveBeenCalledWith(TARGET_TOKEN);
});
