/**
 * ConversationHeader (src/ui/conversations/ConversationHeader.tsx): the iOS chat nav bar. Locks in:
 *   - the TITLE resolves via the same resolveTitle semantics as the tile (custom name → real
 *     display name → participant names), and is masked to "Contact" in redacted mode;
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
 *   `useRedactedModeStore` is the REAL store, driven via setState (reset in afterEach).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { ConversationHeader } from '@ui/conversations/ConversationHeader';
import { useRedactedModeStore } from '@state/redactedModeStore';
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
  const React = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

// ServiceBadge marks its label accessibilityElementsHidden → opt hidden elements in.
const HIDDEN = { includeHiddenElements: true } as const;

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
    handleServices: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
  mockStartCall.mockClear();
  mockHeaderData = null;
  useRedactedModeStore.setState({ enabled: false, hydrated: true });
});

afterEach(() => {
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
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
    fireEvent.press(screen.getByLabelText('Go back'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('tapping the title/avatar opens chat settings with the encoded guid', async () => {
    const guid = 'iMessage;-;+15551230000';
    mockHeaderData = makeHeader({ guid });
    await renderWithTheme(<ConversationHeader chatGuid={guid} data={mockHeaderData} />);
    fireEvent.press(screen.getByLabelText('Alice, chat details'));
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/chat-settings/${encodeURIComponent(guid)}`),
    );
  });

  it('video button starts a FaceTime call for this chat', async () => {
    const guid = 'iMessage;-;+15551230000';
    mockHeaderData = makeHeader({ guid });
    await renderWithTheme(<ConversationHeader chatGuid={guid} data={mockHeaderData} />);
    fireEvent.press(screen.getByLabelText('Start FaceTime call'));
    await waitFor(() =>
      expect(mockStartCall).toHaveBeenCalledWith({ chatGuid: guid, video: true }),
    );
  });

  it('calendar button routes to the scheduled-messages screen', async () => {
    mockHeaderData = makeHeader();
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    fireEvent.press(screen.getByLabelText('View scheduled messages'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/scheduled'));
  });
});

describe('ConversationHeader — redacted mode', () => {
  it('masks the title to "Contact" and hides the real name', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    mockHeaderData = makeHeader({ participantNames: 'Alice' });
    await renderWithTheme(
      <ConversationHeader chatGuid={mockHeaderData.guid} data={mockHeaderData} />,
    );
    expect(screen.getByText('Contact')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    // the details a11y label is redacted too (no identity leak to a screen reader)
    expect(screen.getByLabelText('Contact, chat details')).toBeTruthy();
  });
});

describe('ConversationHeader — before the header row loads', () => {
  it('falls back to "Chat details" and renders no avatar when data is null', async () => {
    await renderWithTheme(<ConversationHeader chatGuid="iMessage;-;+15551230000" data={null} />);
    expect(screen.getByLabelText('Chat details')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });
});
