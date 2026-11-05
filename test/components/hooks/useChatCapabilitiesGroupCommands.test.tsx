import { ServerInfo } from '@core/models';
import type { ChatHeaderRow } from '@db/repositories';
import { useChatCapabilities } from '@features/conversations/useChatCapabilities';
import { useSessionStore } from '@state/sessionStore';
import { resolveChatService } from '@utils';
import { act, renderHook } from '../support/renderWithTheme';

const GROUP = 'iMessage;+;chat-1234';
/** How macOS 26+ stores the same group; bbd takes it only while its FP-006 gate is open. */
const ANY_GROUP = 'any;+;chat-1234';

/** The two features' own reviewed switches. */
const NARROW_ON = { supports_imessage_mentions: true, supports_imessage_remote_delete: true };
/** Any one restored switch being on proves bbd's FP-006 gate is open. */
const GATE_OPEN = { supports_imessage_group_reactions: true };

function groupHeader(overrides: Partial<ChatHeaderRow> = {}): ChatHeaderRow {
  return {
    id: 1,
    guid: ANY_GROUP,
    chatIdentifier: null,
    displayName: null,
    customName: null,
    customColor: null,
    muteType: null,
    style: 43,
    participantCount: 2,
    participantNames: '["Ann","Ben"]',
    participantAvatars: null,
    participantAddresses: 'ann@example.com|||ben@example.com',
    handleServices: 'iMessage,iMessage',
    ...overrides,
  };
}

async function capabilitiesFor(fields: Record<string, unknown>, row: ChatHeaderRow) {
  // Hooks rendered earlier in the same test are still mounted, so publish inside act.
  await act(async () => {
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '2.0.15', ...fields }) });
  });
  const { result } = await renderHook(() =>
    useChatCapabilities(row.guid, row, resolveChatService(row.guid, row.handleServices)),
  );
  return result.current;
}

afterEach(() => {
  useSessionStore.setState({ serverInfo: null });
});

describe('useChatCapabilities: @mentions and Delete from Mac in any;+; groups', () => {
  it('offers both in an any;+; group only while the restored gate is open', async () => {
    let caps = await capabilitiesFor(NARROW_ON, groupHeader());
    expect(caps.imessageMentionsAvailable).toBe(false);
    expect(caps.mentionParticipants).toEqual([]);
    expect(caps.imessageRemoteDeleteAvailable).toBe(false);

    caps = await capabilitiesFor({ ...NARROW_ON, ...GATE_OPEN }, groupHeader());
    expect(caps.imessageMentionsAvailable).toBe(true);
    expect(caps.mentionParticipants).toEqual([
      { address: 'ann@example.com', label: 'Ann' },
      { address: 'ben@example.com', label: 'Ben' },
    ]);
    expect(caps.imessageRemoteDeleteAvailable).toBe(true);
  });

  it('keeps an iMessage;+; group on its reviewed proof whether or not the gate is open', async () => {
    for (const fields of [NARROW_ON, { ...NARROW_ON, ...GATE_OPEN }]) {
      const caps = await capabilitiesFor(fields, groupHeader({ guid: GROUP }));
      expect(caps.imessageMentionsAvailable).toBe(true);
      expect(caps.imessageRemoteDeleteAvailable).toBe(true);
    }
  });

  it("still needs each feature's own switch and an all-iMessage member list", async () => {
    let caps = await capabilitiesFor(GATE_OPEN, groupHeader());
    expect(caps.imessageMentionsAvailable).toBe(false);
    expect(caps.imessageRemoteDeleteAvailable).toBe(false);

    caps = await capabilitiesFor(
      { ...NARROW_ON, ...GATE_OPEN },
      groupHeader({ handleServices: 'iMessage,SMS' }),
    );
    expect(caps.imessageMentionsAvailable).toBe(false);
    expect(caps.mentionParticipants).toEqual([]);
    expect(caps.imessageRemoteDeleteAvailable).toBe(false);
  });
});
