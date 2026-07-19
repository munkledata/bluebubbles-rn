/**
 * Android Direct Share bridge (src/services/shortcuts/shareShortcuts.ts). Verifies the InboxRow →
 * shortcut mapping and the fail-safe contract:
 *   - publishes at most 4 (the most-recent) conversations;
 *   - title falls back customName → displayName → first participant → chatIdentifier → 'Conversation';
 *   - the first participant avatar rides as avatarPath (null when absent);
 *   - every function no-ops (never throws) when the native module is absent.
 *
 * The optional native module is mocked via `expo`'s requireOptionalNativeModule.
 */
import type { InboxRow } from '@db/repositories';

const native = {
  setShareShortcuts: jest.fn(),
  clearShareShortcuts: jest.fn(),
  getLaunchShortcutId: jest.fn(),
};
// Swap to null in the "no native module" test.
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// eslint-disable-next-line import/first
import {
  publishShareShortcuts,
  clearShareShortcuts,
  getLaunchShortcutId,
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

describe('shareShortcuts service', () => {
  beforeEach(() => {
    moduleRef.current = native;
    native.setShareShortcuts.mockClear();
    native.clearShareShortcuts.mockClear();
    native.getLaunchShortcutId.mockClear();
  });

  it('maps rows to shortcuts, capping at 4 most-recent', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ guid: `guid-${i}`, customName: `Chat ${i}` }),
    );
    publishShareShortcuts(rows);
    expect(native.setShareShortcuts).toHaveBeenCalledTimes(1);
    const published = native.setShareShortcuts.mock.calls[0]![0] as unknown[];
    expect(published).toHaveLength(4);
    expect(published[0]).toEqual({ id: 'guid-0', name: 'Chat 0', avatarPath: null });
  });

  it('resolves the title fallback chain and the first avatar', () => {
    publishShareShortcuts([
      row({
        guid: 'a',
        customName: null,
        displayName: null,
        participantNames: 'Mom,Dad',
        participantAvatars: 'file:///mom.jpg,file:///dad.jpg',
        chatIdentifier: '+15550001111',
      }),
    ]);
    expect(native.setShareShortcuts).toHaveBeenCalledWith([
      { id: 'a', name: 'Mom', avatarPath: 'file:///mom.jpg' },
    ]);
  });

  it('falls back to chatIdentifier then Conversation when no names exist', () => {
    publishShareShortcuts([row({ guid: 'b', chatIdentifier: 'chat-b' })]);
    publishShareShortcuts([row({ guid: 'c', chatIdentifier: null })]);
    expect(native.setShareShortcuts).toHaveBeenNthCalledWith(1, [
      { id: 'b', name: 'chat-b', avatarPath: null },
    ]);
    expect(native.setShareShortcuts).toHaveBeenNthCalledWith(2, [
      { id: 'c', name: 'Conversation', avatarPath: null },
    ]);
  });

  it('does not publish an empty list (no rows)', () => {
    publishShareShortcuts([]);
    expect(native.setShareShortcuts).toHaveBeenCalledWith([]);
  });

  it('forwards clear + getLaunchShortcutId to the native module', () => {
    native.getLaunchShortcutId.mockReturnValue('iMessage;-;+1555');
    expect(getLaunchShortcutId()).toBe('iMessage;-;+1555');
    clearShareShortcuts();
    expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('no-ops safely when the native module is absent', () => {
    moduleRef.current = null;
    expect(() => publishShareShortcuts([row({ guid: 'z' })])).not.toThrow();
    expect(() => clearShareShortcuts()).not.toThrow();
    expect(getLaunchShortcutId()).toBeNull();
  });
});
