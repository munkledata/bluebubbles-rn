/**
 * ConversationHeader (src/ui/conversations/ConversationHeader.tsx): the iOS chat nav bar. Locks in:
 *   - the TITLE resolves via the same resolveTitle semantics as the tile (custom name → real
 *     display name → participant names), with the exact address and avatar photo where available;
 *   - the SERVICE badge derives from the chat guid prefix via resolveChatService (RCS/SMS/iMessage);
 *   - the affordances fire the right navigation/call side-effects: back → router.back(); the
 *     centered avatar/title → router.push('/chat-settings/<encoded guid>'); the video button →
 *     useFaceTime().startCall({ chatGuid, video: true }); the calendar button → router.push('/scheduled');
 *   - when the header row hasn't loaded (data null) no avatar renders and the details a11y label
 *     falls back to "Chat details".
 *
 * The header row arrives as the `data` PROP (the screen owns the single useChatHeader
 * subscription and passes it down), so tests seed it directly — no data-hook mock.
 *
 * In-file mocks:
 *   - `expo-router` → useRouter with jest.fn push/back (mockPush/mockBack).
 *   - `@features/facetime/useFaceTime` → returns { startCall } (the real hook pulls services/web-browser).
 *   - `react-native-safe-area-context` → zero insets.
 *   - `@expo/vector-icons` → a synchronous Text marker (the real Ionicons does an async font-load
 *     setState that trips overlapping-act; the header renders two icons).
 */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { ConversationHeader } from '@ui/conversations/ConversationHeader';
import type { ChatHeaderRow } from '@db/repositories';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockStartCall = jest.fn(() => Promise.resolve());
let mockHeaderData: ChatHeaderRow | null = null;

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));

jest.mock('@features/facetime/useFaceTime', () => ({
  useFaceTime: () => ({ startCall: mockStartCall, startCallTo: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Ionicons' async font-load setState trips overlapping-act; render its name synchronously.
jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

// ServiceBadge marks its label accessibilityElementsHidden → opt hidden elements in.
const HIDDEN = { includeHiddenElements: true } as const;
const PRIVATE_TITLE = 'private-header-title-7c91@example.test';
const PRIVATE_PARTICIPANT = 'private-header-person-a31d@example.test';
const PRIVATE_ADDRESS = 'private-header-address-5d02@example.test';
const PRIVATE_AVATAR_URI = 'file:///private-header-avatar-64e9-contact-photo.jpg';
const PRIVATE_GROUP_PERSON_A = 'private-header-group-person-a-9f11@example.test';
const PRIVATE_GROUP_PERSON_B = 'private-header-group-person-b-38da-+15557654321';
const PRIVATE_GROUP_ADDRESS_A = 'private-header-group-address-a@example.test';
const PRIVATE_GROUP_ADDRESS_B = '+15559876543';
const PRIVATE_GROUP_AVATAR_A = 'file:///private-header-group-avatar-a-808d.jpg';
const PRIVATE_GROUP_AVATAR_B = 'file:///private-header-group-avatar-b-d197.jpg';

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

function makeHeader(overrides: Partial<ChatHeaderRow> = {}): ChatHeaderRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    muteType: null,
    style: 45, // 1:1
    participantCount: 1,
    participantNames: 'Alice',
    participantAvatars: null,
    participantAddresses: '+15551230000',
    handleServices: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
  mockStartCall.mockClear();
  mockHeaderData = null;
});

describe('ConversationHeader — title resolution', () => {
  it('renders the participant name for a 1:1 chat', async () => {
    mockHeaderData = makeHeader({ participantNames: 'Alice' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('prefers a local custom name over the display/participant names', async () => {
    mockHeaderData = makeHeader({
      style: 43,
      customName: 'Weekend Crew',
      displayName: 'ignored',
      participantNames: 'Alice, Bob',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('Weekend Crew')).toBeTruthy();
    expect(screen.queryByText('Alice, Bob')).toBeNull();
  });

  it('renders the participant list for a group with no custom/display name', async () => {
    mockHeaderData = makeHeader({ style: 43, participantCount: 2, participantNames: 'Alice, Bob' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('Alice, Bob')).toBeTruthy();
  });

  it('renders exact 1:1 title, address, avatar URI, and details accessibility label', async () => {
    mockHeaderData = makeHeader({
      chatIdentifier: PRIVATE_ADDRESS,
      customName: PRIVATE_TITLE,
      participantNames: PRIVATE_PARTICIPANT,
      participantAddresses: PRIVATE_ADDRESS,
      participantAvatars: PRIVATE_AVATAR_URI,
    });
    const view = await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );

    expect(screen.getByText(PRIVATE_TITLE)).toBeTruthy();
    expect(screen.getByText(PRIVATE_ADDRESS, HIDDEN)).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: `${PRIVATE_TITLE}, ${PRIVATE_ADDRESS}, chat details`,
      }),
    ).toBeEnabled();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_AVATAR_URI);
  });

  it('renders exact group title, both avatar URIs, and details accessibility label', async () => {
    const groupTitle = `${PRIVATE_GROUP_PERSON_A}, ${PRIVATE_GROUP_PERSON_A}, ${PRIVATE_GROUP_PERSON_B}`;
    mockHeaderData = makeHeader({
      guid: 'RCS;-;chat-private-group',
      style: 43,
      participantCount: 3,
      participantNames: groupTitle,
      participantAddresses: `${PRIVATE_GROUP_ADDRESS_A}|||${PRIVATE_GROUP_ADDRESS_A}|||${PRIVATE_GROUP_ADDRESS_B}`,
      participantAvatars: `${PRIVATE_GROUP_AVATAR_A}|||${PRIVATE_GROUP_AVATAR_A}|||${PRIVATE_GROUP_AVATAR_B}`,
    });
    const view = await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );

    expect(screen.getByText(groupTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: `${groupTitle}, chat details` })).toBeEnabled();
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain(PRIVATE_GROUP_AVATAR_A);
    expect(tree).toContain(PRIVATE_GROUP_AVATAR_B);
    expect(screen.getByText('RCS', HIDDEN)).toBeTruthy();
  });
});

describe('ConversationHeader — contact number under the name', () => {
  // The subtitle is marked accessibilityElementsHidden (the Pressable's label announces it once),
  // so every query for it has to opt hidden elements in.
  it('shows the 1:1 contact’s formatted number beneath their name', async () => {
    mockHeaderData = makeHeader({
      participantNames: 'Alice',
      participantAddresses: '+15551230000',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('+1 (555) 123-0000', HIDDEN)).toBeTruthy();
  });

  it('shows an email handle verbatim', async () => {
    mockHeaderData = makeHeader({
      chatIdentifier: 'alice@example.com',
      participantNames: 'Alice',
      participantAddresses: 'alice@example.com',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('alice@example.com', HIDDEN)).toBeTruthy();
  });

  it('prefers the handle the thread is keyed on when the contact has two', async () => {
    mockHeaderData = makeHeader({
      chatIdentifier: 'alice@example.com',
      participantCount: 2,
      participantNames: 'Alice, Alice',
      participantAddresses: '+15551230000|||alice@example.com',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('alice@example.com', HIDDEN)).toBeTruthy();
    expect(screen.queryByText('+1 (555) 123-0000', HIDDEN)).toBeNull();
  });

  it('does NOT repeat the number when it is already the title (unsaved contact)', async () => {
    // participantNames falls back to the raw address for a contact not in the address book, so the
    // title IS the number — a subtitle here would just duplicate the line above it.
    mockHeaderData = makeHeader({
      participantNames: '+1 (555) 123-0000',
      participantAddresses: '+15551230000',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getAllByText('+1 (555) 123-0000', HIDDEN)).toHaveLength(1);
    expect(screen.getByLabelText('+1 (555) 123-0000, chat details')).toBeTruthy();
  });

  it('shows no number for a GROUP chat', async () => {
    mockHeaderData = makeHeader({
      style: 43,
      chatIdentifier: 'chat947991747861991169',
      participantCount: 2,
      participantNames: 'Alice, Bob',
      participantAddresses: '+15551230000|||+15559990000',
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.queryByText('+1 (555) 123-0000', HIDDEN)).toBeNull();
    expect(screen.getByLabelText('Alice, Bob, chat details')).toBeTruthy();
  });

  it('falls back to the chat identifier when the handles have not synced yet', async () => {
    mockHeaderData = makeHeader({
      chatIdentifier: '+15551230000',
      participantNames: 'Alice',
      participantAddresses: null,
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('+1 (555) 123-0000', HIDDEN)).toBeTruthy();
  });

  it('never surfaces a raw chat-guid identifier as if it were a number', async () => {
    mockHeaderData = makeHeader({
      chatIdentifier: 'chat947991747861991169',
      participantNames: 'Alice',
      participantAddresses: null,
    });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.queryByText('chat947991747861991169', HIDDEN)).toBeNull();
    expect(screen.getByLabelText('Alice, chat details')).toBeTruthy();
  });
});

describe('ConversationHeader — service badge', () => {
  it('badges an RCS guid as "RCS"', async () => {
    mockHeaderData = makeHeader({ guid: 'RCS;-;+15551230000' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('RCS', HIDDEN)).toBeTruthy();
  });

  it('badges an SMS guid as "SMS"', async () => {
    mockHeaderData = makeHeader({ guid: 'SMS;-;+15551230000' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('SMS', HIDDEN)).toBeTruthy();
  });

  it('badges an iMessage guid as "iMessage"', async () => {
    mockHeaderData = makeHeader({ guid: 'iMessage;-;+15551230000' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('iMessage', HIDDEN)).toBeTruthy();
  });
});

describe('ConversationHeader — affordances', () => {
  it('back button routes router.back()', async () => {
    mockHeaderData = makeHeader();
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    await fireEvent.press(screen.getByLabelText('Go back'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('tapping the title/avatar opens chat settings with the encoded guid', async () => {
    const guid = 'iMessage;-;+15551230000';
    mockHeaderData = makeHeader({ guid });
    await renderWithTheme(<ConversationHeader chatGuid={guid} data={mockHeaderData} />);
    const detailsPress = retainConfiguredPress(
      screen.getByRole('button', {
        name: 'Alice, +1 (555) 123-0000, chat details',
      }),
    );
    await act(async () => {
      detailsPress();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/chat-settings/${encodeURIComponent(guid)}`),
    );
  });

  it('video button starts a FaceTime call for this chat', async () => {
    const guid = 'iMessage;-;+15551230000';
    mockHeaderData = makeHeader({ guid });
    await renderWithTheme(<ConversationHeader chatGuid={guid} data={mockHeaderData} />);
    await fireEvent.press(screen.getByLabelText('Start FaceTime call'));
    await waitFor(() =>
      expect(mockStartCall).toHaveBeenCalledWith({ chatGuid: guid, video: true }),
    );
  });

  it('calendar button routes to the scheduled-messages screen', async () => {
    mockHeaderData = makeHeader();
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    await fireEvent.press(screen.getByLabelText('View scheduled messages'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/scheduled'));
  });
});

describe('ConversationHeader — before the header row loads', () => {
  it('falls back to "Chat details" and renders no avatar when data is null', async () => {
    await renderWithTheme(<ConversationHeader chatGuid="iMessage;-;+15551230000" data={null} />);
    expect(screen.getByLabelText('Chat details')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });
});
