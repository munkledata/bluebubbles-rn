/**
 * Android Direct Share bridge (src/services/shortcuts/shareShortcuts.ts). Verifies the InboxRow →
 * shortcut mapping and the fail-safe contract:
 *   - offers up to 10 recent conversations (the NATIVE half does the real device clamp);
 *   - title falls back customName → displayName → first participant → chatIdentifier → 'Conversation';
 *   - the first AVAILABLE participant avatar rides as avatarPath (null when none), parsed with the
 *     '|||' delimiter the inbox query actually uses;
 *   - redacted mode publishes NOTHING and clears what was already published;
 *   - repeat publishes of identical content hit native only once;
 *   - every function no-ops (never throws) when the native module is absent.
 *
 * The optional native module is mocked via `expo`'s requireOptionalNativeModule.
 */
import type { InboxRow } from '@db/repositories';

const native = {
  setShareShortcuts: jest.fn(),
  clearShareShortcuts: jest.fn(),
  getLaunchShortcutId: jest.fn(),
  reportShortcutUsed: jest.fn(),
};
// Swap to null in the "no native module" test.
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// eslint-disable-next-line import/first
import {
  __resetShareShortcutsCache,
  clearShareShortcuts,
  getLaunchShortcutId,
  publishShareShortcuts,
  reportChatOpened,
  toShareShortcuts,
} from '@/services/shortcuts/shareShortcuts';

/** Minimal InboxRow — only the fields the service reads matter; the rest are filler. */
function row(over: Partial<InboxRow>): InboxRow {
  return {
    id: 1,
    guid: 'g',
    chatIdentifier: null,
    displayName: null,
    customName: null,
    customColor: null,
    style: null,
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: null,
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
    participantNames: null,
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    hasKnownSender: 1,
    ...over,
  } as InboxRow;
}

const publish = (rows: InboxRow[], redacted = false) =>
  publishShareShortcuts(rows, { redacted });

/** First argument of the Nth setShareShortcuts call. */
const publishedAt = (n = 0) => native.setShareShortcuts.mock.calls[n]?.[0] as unknown[] | undefined;

describe('shareShortcuts service', () => {
  beforeEach(() => {
    moduleRef.current = native;
    native.setShareShortcuts.mockClear();
    native.clearShareShortcuts.mockClear();
    native.getLaunchShortcutId.mockClear();
    native.reportShortcutUsed.mockClear();
    // The publish dedupe is module-level state — reset it so cases don't leak into each other.
    __resetShareShortcutsCache();
  });

  it('offers up to 10 most-recent conversations', () => {
    publish(Array.from({ length: 14 }, (_, i) => row({ guid: `guid-${i}`, customName: `Chat ${i}` })));
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
    expect(publishedAt()).toHaveLength(10);
    expect(publishedAt()?.[0]).toEqual({ id: 'guid-0', name: 'Chat 0', avatarPath: null });
  });

  it('resolves the title fallback chain and the first avatar', () => {
    publish([
      row({
        guid: 'a',
        participantNames: 'Mom,Dad',
        // The inbox query joins avatars with '|||', NOT ',' (see listChatsForInbox).
        participantAvatars: 'file:///mom.jpg|||file:///dad.jpg',
        chatIdentifier: '+15550001111',
      }),
    ]);
    expect(publishedAt()).toEqual([{ id: 'a', name: 'Mom', avatarPath: 'file:///mom.jpg' }]);
  });

  it('does not split an avatar uri that itself contains a comma', () => {
    publish([row({ guid: 'a', participantAvatars: 'file:///Mom%2C%20Home.jpg|||file:///dad.jpg' })]);
    expect(publishedAt()).toEqual([
      expect.objectContaining({ avatarPath: 'file:///Mom%2C%20Home.jpg' }),
    ]);
  });

  it('uses the first AVAILABLE avatar when an earlier participant has no photo', () => {
    publish([row({ guid: 'a', participantAvatars: '|||file:///dad.jpg' })]);
    expect(publishedAt()).toEqual([expect.objectContaining({ avatarPath: 'file:///dad.jpg' })]);
  });

  it('is null when no participant has a photo', () => {
    publish([row({ guid: 'a', participantAvatars: '|||' })]);
    expect(publishedAt()).toEqual([expect.objectContaining({ avatarPath: null })]);
  });

  it('falls back to chatIdentifier then Conversation when no names exist', () => {
    publish([row({ guid: 'b', chatIdentifier: 'chat-b' })]);
    publish([row({ guid: 'c', chatIdentifier: null })]);
    expect(publishedAt(0)).toEqual([{ id: 'b', name: 'chat-b', avatarPath: null }]);
    expect(publishedAt(1)).toEqual([{ id: 'c', name: 'Conversation', avatarPath: null }]);
  });

  it('does not touch native for an empty row list that was never published', () => {
    publish([]);
    expect(native.setShareShortcuts).not.toHaveBeenCalled();
    expect(native.clearShareShortcuts).not.toHaveBeenCalled();
  });

  describe('redacted mode', () => {
    it('publishes nothing', () => {
      publish([row({ guid: 'a', customName: 'Mom' })], true);
      expect(native.setShareShortcuts).not.toHaveBeenCalled();
    });

    it('CLEARS chips that were already published when it turns on', () => {
      publish([row({ guid: 'a', customName: 'Mom' })]);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
      publish([row({ guid: 'a', customName: 'Mom' })], true);
      expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
    });

    it('clears on the FIRST publish after a restart, having published nothing this session', () => {
      // Dynamic shortcuts are persistent system state: chips published before redacted mode was
      // turned on are still live after the process restarts, so "we published nothing yet" is NOT
      // a reason to skip clearing.
      publish([row({ guid: 'a', customName: 'Mom' })], true);
      expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
    });

    it('clears only once while it stays on', () => {
      publish([row({ guid: 'a', customName: 'Mom' })], true);
      publish([row({ guid: 'b', customName: 'Dad' })], true);
      publish([row({ guid: 'c', customName: 'Sam' })], true);
      expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
    });

    it('publishes again once it is turned back off', () => {
      publish([row({ guid: 'a', customName: 'Mom' })], true);
      publish([row({ guid: 'a', customName: 'Mom' })], false);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
      expect(publishedAt()).toEqual([{ id: 'a', name: 'Mom', avatarPath: null }]);
    });

    it('toShareShortcuts maps nothing regardless of the rows', () => {
      expect(toShareShortcuts([row({ guid: 'a', customName: 'Mom' })], { redacted: true })).toEqual(
        [],
      );
    });
  });

  describe('publish dedupe', () => {
    it('hits native ONCE for repeated identical content', () => {
      const rows = [row({ guid: 'a', customName: 'Mom' })];
      publish(rows);
      publish(rows);
      publish([row({ guid: 'a', customName: 'Mom' })]); // equal by value, new objects
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
    });

    it('republishes when only the TITLE changes (the old guid-keyed memo missed this)', () => {
      publish([row({ guid: 'a', customName: 'Mom' })]);
      publish([row({ guid: 'a', customName: 'Mom Cell' })]);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(2);
    });

    it('republishes when only the AVATAR changes (a contact-sync backfill)', () => {
      publish([row({ guid: 'a', customName: 'Mom' })]);
      publish([row({ guid: 'a', customName: 'Mom', participantAvatars: 'file:///mom.jpg' })]);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(2);
    });

    it('clearShareShortcuts resets the dedupe so the next identical publish goes through', () => {
      const rows = [row({ guid: 'a', customName: 'Mom' })];
      publish(rows);
      clearShareShortcuts();
      publish(rows);
      expect(native.setShareShortcuts).toHaveBeenCalledTimes(2);
    });
  });

  it('forwards clear + getLaunchShortcutId to the native module', () => {
    native.getLaunchShortcutId.mockReturnValue('iMessage;-;+1555');
    expect(getLaunchShortcutId()).toBe('iMessage;-;+1555');
    clearShareShortcuts();
    expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('reports shortcut usage, ignoring an empty guid', () => {
    reportChatOpened('iMessage;-;+1555');
    expect(native.reportShortcutUsed).toHaveBeenCalledWith('iMessage;-;+1555');
    native.reportShortcutUsed.mockClear();
    reportChatOpened('');
    expect(native.reportShortcutUsed).not.toHaveBeenCalled();
  });

  it('reportChatOpened no-ops on a build whose native half predates it', () => {
    moduleRef.current = { ...native, reportShortcutUsed: undefined as never };
    expect(() => reportChatOpened('guid')).not.toThrow();
  });

  it('no-ops safely when the native module is absent', () => {
    moduleRef.current = null;
    expect(() => publish([row({ guid: 'z' })])).not.toThrow();
    expect(() => clearShareShortcuts()).not.toThrow();
    expect(() => reportChatOpened('z')).not.toThrow();
    expect(getLaunchShortcutId()).toBeNull();
  });
});
