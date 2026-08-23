/**
 * NewChatScreen route (app/(app)/new-chat.tsx): start a conversation.
 *
 * The contact search + existing-chat lookup + create-chat service are all mocked in-file
 * so the suite locks in the SCREEN'S own behavior:
 *   - a `forwardText` route param pre-fills the message composer (the chat "Forward" action);
 *   - recipient entry (commit a raw typed address / tap a suggestion) builds chips;
 *   - Start is gated on having a recipient AND a message — an empty form never calls the
 *     create service;
 *   - a successful create routes to `/chat/<encoded guid>` via `router.replace`;
 *   - a failed create surfaces a dialog;
 *   - an already-existing chat with the chosen recipients offers an "Open it" shortcut.
 *
 * Mock note: a jest.mock factory must NOT dereference an outer `const mock…` at factory-eval
 * time (ES imports hoist above the const initializers → still `undefined`). So the factories
 * create their `jest.fn()`s inline and we grab references AFTER import. The `mockSearchParams`
 * object IS referenced lazily inside useLocalSearchParams()'s body (called at render), so it's
 * safe there. The dialog store is the REAL singleton.
 */
import React from 'react';
import { Keyboard } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import { logger } from '@core/secure';
import type { ContactPick } from '@db/repositories';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams: {
  forwardText?: string;
  forwardAttachmentHandoff?: string;
  /** Legacy/public payload retained only to prove the route ignores it. */
  forwardAttachments?: string;
} = {};
// Per-uri fake filesystem for the forwarded-attachment validation (File.exists/.size).
// Referenced LAZILY from the mock class's getters (safe under factory hoisting, like
// mockSearchParams), and reset in beforeEach.
const mockFiles: Record<string, { exists: boolean; size: number | null }> = {};
const mockFileInfoReads: string[] = [];

// The full `@ui` barrel drags in native/ESM modules (expo-video/expo-image/ky). The screen only
// needs `Screen` + `useTheme`, so swap the barrel for its two lightweight submodules.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));
jest.mock('expo-file-system', () => ({
  Paths: {
    cache: { uri: 'file:///data/cache/' },
    document: { uri: 'file:///data/doc/' },
  },
  File: class {
    private readonly mockUri: string;
    constructor(uri: string) {
      this.mockUri = uri;
    }
    get exists(): boolean {
      mockFileInfoReads.push(`exists:${this.mockUri}`);
      return mockFiles[this.mockUri]?.exists ?? false;
    }
    get size(): number | null {
      mockFileInfoReads.push(`size:${this.mockUri}`);
      return mockFiles[this.mockUri]?.size ?? null;
    }
  },
}));
// Expo Image's SDK 57 observe integration expects a native ExpoObserve shape that jest-expo's
// current mock does not provide. This screen only needs a thumbnail host in these tests.
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => R.createElement(View, props) };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({ createNewChat: jest.fn(), http: {} }));
jest.mock('@/services/send', () => ({ sendImages: jest.fn() }));
jest.mock('@core/api/endpoints/handles', () => ({ checkIMessageAvailability: jest.fn() }));
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  searchContactAddresses: jest.fn(),
  findChatByParticipantAddresses: jest.fn(),
}));

// eslint-disable-next-line import/first
import NewChatScreen from '../../../app/(app)/new-chat';
// eslint-disable-next-line import/first
import { createNewChat } from '@/services';
// eslint-disable-next-line import/first
import { sendImages } from '@/services/send';
// eslint-disable-next-line import/first
import { searchContactAddresses, findChatByParticipantAddresses } from '@db/repositories';
// eslint-disable-next-line import/first
import { checkIMessageAvailability } from '@core/api/endpoints/handles';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { ServerInfo } from '@core/models';
// eslint-disable-next-line import/first
import { useShareIntentStore } from '@state/shareIntentStore';
// eslint-disable-next-line import/first
import {
  clearForwardAttachmentHandoffs,
  stageForwardAttachmentHandoff,
} from '@features/conversations/forwardAttachmentHandoff';

const mockCreateNewChat = createNewChat as jest.Mock;
const mockSendImages = sendImages as jest.Mock;
const mockSearchContacts = searchContactAddresses as jest.Mock;
const mockFindChat = findChatByParticipantAddresses as jest.Mock;
const mockCheckAvailability = checkIMessageAvailability as jest.Mock;
const clearShareIntentStore = useShareIntentStore.getState().clear;

const PRIVATE_NAME = 'new-chat-private-contact-7f31';
const PRIVATE_ADDRESS = '+15559876543';
const SECOND_NAME = 'new-chat-second-contact-63aa';
const SECOND_ADDRESS = '+15557654321';
const PRIVATE_QUERY = 'new-chat-private-query-c2e8';
const PRIVATE_MESSAGE = 'new-chat-private-draft-84bd';
const SECOND_MESSAGE = 'new-chat-current-draft-52e1';
const PRIVATE_URI = 'file:///cache/shared-in/new-chat-private-image-59ac.jpg';
const PRIVATE_FILENAME = 'new-chat-private-image-59ac.jpg';
const FORWARD_URI = 'file:///data/doc/attachments/new-chat-private-forward-e901.jpg';
const FORWARD_FILENAME = 'new-chat-private-forward-e901.jpg';
const FORWARD_NONCE = '44444444-4444-4444-8444-444444444444';
const PRIVATE_EXISTING_GUID = 'iMessage;-;new-chat-private-existing-2b4e';
const PRIVATE_CREATED_GUID = 'iMessage;-;new-chat-private-created-d913';
const SECOND_CREATED_GUID = 'iMessage;-;new-chat-current-created-471a';
const ACCOUNT_CHANGED_COPY = 'Account changed. Go back and start a new message again.';
let keyboardDismissSpy: jest.SpiedFunction<typeof Keyboard.dismiss>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function retainConfiguredPress(node: {
  props: Record<string, unknown>;
  parent?: { props: Record<string, unknown>; parent?: unknown } | null;
}): () => void {
  let current: { props: Record<string, unknown>; parent?: unknown } | null = node;
  while (current) {
    const responder = current.props.onStartShouldSetResponder;
    if (typeof responder === 'function') {
      const readConfig = (
        responder as typeof responder & {
          testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
        }
      ).testOnly_pressabilityConfig;
      if (typeof readConfig === 'function') {
        const onPress = readConfig().onPress;
        if (typeof onPress === 'function') return () => onPress({ nativeEvent: {} });
      }
    }
    current = current.parent as typeof current;
  }
  throw new Error('Expected configured Pressable onPress');
}

function sharedPrivateImage() {
  return {
    uri: PRIVATE_URI,
    name: PRIVATE_FILENAME,
    mimeType: 'image/jpeg',
    size: 4096,
  };
}

function stageProtectedForward(release: jest.Mock): void {
  mockFiles[FORWARD_URI] = { exists: true, size: 8192 };
  expect(
    stageForwardAttachmentHandoff({
      nonce: FORWARD_NONCE,
      attachments: [{ uri: FORWARD_URI, name: FORWARD_FILENAME, mimeType: 'image/jpeg' }],
      isCurrent: () => true,
      protectPath: () => ({ release }),
    }),
  ).toBe(FORWARD_NONCE);
  mockSearchParams = { forwardText: PRIVATE_MESSAGE, forwardAttachmentHandoff: FORWARD_NONCE };
}

function expectPrivateHostCanariesAbsent(tree: unknown): void {
  const json = JSON.stringify(tree);
  for (const canary of [
    PRIVATE_NAME,
    PRIVATE_ADDRESS,
    PRIVATE_QUERY,
    PRIVATE_MESSAGE,
    PRIVATE_URI,
    FORWARD_URI,
  ]) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(canary)).toBeNull();
    expect(screen.queryByDisplayValue(canary)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

function expectAccountChangedComposer(tree: unknown): void {
  const notice = screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY });
  expect(notice.type).toBe('Text');
  expect(screen.getByText('New Message')).toBeTruthy();
  expect(screen.getByText('‹ Back')).toBeTruthy();
  expect(screen.queryByText('Start')).toBeNull();
  expect(screen.queryByText(/Open it/)).toBeNull();
  expect(screen.queryByText('To:')).toBeNull();
  expect(screen.queryByPlaceholderText('Phone or email')).toBeNull();
  expect(screen.queryByPlaceholderText('Add another…')).toBeNull();
  expect(screen.queryByPlaceholderText('Message')).toBeNull();
  expect(screen.queryByPlaceholderText('Add a message (optional)')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  expectPrivateHostCanariesAbsent(tree);
}

function expectImageUriHost(tree: unknown, uri = PRIVATE_URI): void {
  expect(JSON.stringify(tree)).toContain(uri);
}

beforeEach(() => {
  clearForwardAttachmentHandoffs();
  resumeRealtimeDeliveries();
  mockSearchParams = {};
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFileInfoReads.length = 0;
  mockSendImages.mockResolvedValue([]);
  mockSearchContacts.mockResolvedValue([] as ContactPick[]);
  mockFindChat.mockResolvedValue(null);
  mockCreateNewChat.mockResolvedValue('iMessage;-;+15551234567');
  // Default: no probe resolves (helper down) → chips stay neutral, service stays iMessage.
  mockCheckAvailability.mockRejectedValue(new Error('no helper'));
  useDialogStore.setState({ current: null, queue: [] });
  useShareIntentStore.setState({ text: null, files: [], clear: clearShareIntentStore });
  keyboardDismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  // Default: no server capabilities → the RCS chip is hidden.
  useSessionStore.setState({ serverInfo: null });
});

afterEach(() => {
  keyboardDismissSpy.mockRestore();
  jest.restoreAllMocks();
  resumeRealtimeDeliveries();
});

/** Commit a typed address as a recipient chip. */
async function addRecipient(address: string): Promise<void> {
  const toInput = screen.getByPlaceholderText(
    screen.queryByPlaceholderText('Phone or email') ? 'Phone or email' : 'Add another…',
  );
  await act(async () => {
    fireEvent.changeText(toInput, address);
  });
  await act(async () => {
    fireEvent(toInput, 'submitEditing');
  });
}

describe('NewChatScreen — iMessage availability + auto-SMS', () => {
  it('auto-switches to SMS when a recipient is confirmed iMessage-unavailable', async () => {
    mockCheckAvailability.mockResolvedValue(false);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    // The chip flips to its SMS-only label once the probe resolves.
    await screen.findByLabelText('Remove +15551230000 (SMS only)');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551230000'],
        'hi',
        'SMS',
        expect.anything(),
      ),
    );
  });

  it('keeps the manual iMessage choice even after a later probe resolves SMS-only', async () => {
    mockCheckAvailability.mockResolvedValue(false);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await screen.findByLabelText('Remove +15551230000 (SMS only)');
    // User overrides back to iMessage.
    await act(async () => {
      fireEvent.press(screen.getByText('iMessage'));
    });
    // A second recipient's probe resolves later → the auto-effect re-runs but must NOT clobber.
    await addRecipient('+15559990000');
    await screen.findByLabelText('Remove +15559990000 (SMS only)');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551230000', '+15559990000'],
        'hi',
        'iMessage',
        expect.anything(),
      ),
    );
  });

  it('probes each address once and applies an in-flight result across recipient changes', async () => {
    // Never-auto-resolving probes: capture the resolvers so we control WHEN each lands.
    const resolvers: Array<(available: boolean) => void> = [];
    mockCheckAvailability.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await addRecipient('+15559990000');
    // One probe per address — the recipients change must NOT re-issue the first (still
    // in-flight) probe.
    expect(mockCheckAvailability).toHaveBeenCalledTimes(2);
    // The first probe resolves AFTER the recipient list changed — its result still lands.
    await act(async () => {
      resolvers[0]!(false);
    });
    await screen.findByLabelText('Remove +15551230000 (SMS only)');
  });
});

describe('NewChatScreen — RCS service option (server-gated)', () => {
  const rcsServerInfo = ServerInfo.parse({ version: '1.9.0', rcs: true });

  it('hides the RCS chip when the server lacks the capability', async () => {
    await renderWithTheme(<NewChatScreen />);
    expect(screen.getByText('SMS')).toBeTruthy(); // the service row rendered…
    expect(screen.queryByText('RCS')).toBeNull(); // …without an RCS chip
  });

  it('shows the RCS chip when the server advertises RCS and sends with service=RCS', async () => {
    useSessionStore.setState({ serverInfo: rcsServerInfo });
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.press(screen.getByText('RCS'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551230000'],
        'hi',
        'RCS',
        expect.anything(),
      ),
    );
  });

  it('blocks Start for a multi-recipient RCS chat (1:1 only) and unblocks on removal', async () => {
    useSessionStore.setState({ serverInfo: rcsServerInfo });
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await addRecipient('+15559990000');
    await act(async () => {
      fireEvent.press(screen.getByText('RCS'));
    });
    // The inline 1:1 note appears and Start is inert.
    await screen.findByText(/one-to-one/);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() => expect(mockCreateNewChat).not.toHaveBeenCalled());
    // Dropping back to one recipient clears the note and lets the create through.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Remove +15559990000'));
    });
    await waitFor(() => expect(screen.queryByText(/one-to-one/)).toBeNull());
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551230000'],
        'hi',
        'RCS',
        expect.anything(),
      ),
    );
  });
});

describe('NewChatScreen — forward prefill', () => {
  it('pre-fills the composer from the forwardText param', async () => {
    mockSearchParams = { forwardText: 'Forwarded body' };
    await renderWithTheme(<NewChatScreen />);
    expect(screen.getByPlaceholderText('Message').props.value).toBe('Forwarded body');
  });

  it('stages a forwarded attachment (existing file) and sends it after the chat is created', async () => {
    const uri = 'file:///data/doc/attachments/IMG_0001.jpeg';
    const nonce = '11111111-1111-4111-8111-111111111111';
    mockFiles[uri] = { exists: true, size: 1234 };
    expect(
      stageForwardAttachmentHandoff({
        nonce,
        attachments: [{ uri, name: 'IMG_0001.jpeg', mimeType: 'image/jpeg' }],
        isCurrent: () => true,
      }),
    ).toBe(nonce);
    mockSearchParams = { forwardAttachmentHandoff: nonce };
    await renderWithTheme(<NewChatScreen />);

    // The attachment tray renders the staged file (its remove affordance is the stable handle),
    // and the message placeholder flips to optional.
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(screen.getByPlaceholderText('Add a message (optional)')).toBeTruthy();

    // Attachment-only forward: Start is enabled with no typed message.
    await addRecipient('+15551234567');
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockSendImages).toHaveBeenCalledWith(
        {
          chatGuid: 'iMessage;-;+15551234567',
          images: [{ uri, name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', size: 1234 }],
        },
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });

  it('does not stage a forwarded attachment whose file is missing on disk', async () => {
    const nonce = '22222222-2222-4222-8222-222222222222';
    expect(
      stageForwardAttachmentHandoff({
        nonce,
        attachments: [
          {
            uri: 'file:///data/doc/attachments/gone.jpeg',
            name: 'gone.jpeg',
            mimeType: 'image/jpeg',
          },
        ],
        isCurrent: () => true,
      }),
    ).toBe(nonce);
    mockSearchParams = {
      forwardText: 'still forwards the text',
      forwardAttachmentHandoff: nonce,
    };
    await renderWithTheme(<NewChatScreen />);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
    expect(screen.getByPlaceholderText('Message').props.value).toBe('still forwards the text');
  });

  it('ignores direct/public attachment JSON even when it names an existing app-owned file', async () => {
    const uri = 'file:///data/doc/attachments/private.jpeg';
    mockFiles[uri] = { exists: true, size: 1234 };
    mockSearchParams = {
      forwardAttachments: JSON.stringify([{ uri, name: 'private.jpeg', mimeType: 'image/jpeg' }]),
    };
    await renderWithTheme(<NewChatScreen />);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });

  it('ignores a public handoff token that was never staged inside this process', async () => {
    mockSearchParams = {
      forwardAttachmentHandoff: '33333333-3333-4333-8333-333333333333',
    };
    await renderWithTheme(<NewChatScreen />);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });
});

describe('NewChatScreen — shared-in prefill', () => {
  it('captures shared text/files as initial state and clears the hand-off store after mount', async () => {
    const sharedFile = {
      uri: 'file:///cache/shared-in/report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 42,
    };
    useShareIntentStore.setState({ text: 'Shared note', files: [sharedFile] });

    await renderWithTheme(<NewChatScreen />);

    expect(screen.getByPlaceholderText('Add a message (optional)').props.value).toBe('Shared note');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(useShareIntentStore.getState().text).toBeNull();
    expect(useShareIntentStore.getState().files).toEqual([]);
  });
});

describe('NewChatScreen — recipient entry + create', () => {
  it('commits a typed address as a chip and starts the chat', async () => {
    mockSearchParams = { forwardText: 'Hello there' };
    await renderWithTheme(<NewChatScreen />);

    const toInput = screen.getByPlaceholderText('Phone or email');
    await act(async () => {
      fireEvent.changeText(toInput, '+15551234567');
    });
    await act(async () => {
      fireEvent(toInput, 'submitEditing');
    });
    // The chip renders the committed address.
    expect(await screen.findByText('+15551234567 ✕')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551234567'],
        'Hello there',
        'iMessage',
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        `/chat/${encodeURIComponent('iMessage;-;+15551234567')}`,
      ),
    );
  });

  it('adds a recipient by tapping a contact suggestion', async () => {
    mockSearchContacts.mockResolvedValue([{ name: 'Alice', address: '+15550000001' }]);
    await renderWithTheme(<NewChatScreen />);
    // Suggestion appears once the (async) contact search resolves.
    await act(async () => {
      fireEvent.press(await screen.findByText('Alice'));
    });
    expect(await screen.findByText('Alice ✕')).toBeTruthy();
  });

  it('renders private compose data in confirmed normal mode and keeps exact actions internal', async () => {
    useShareIntentStore.setState({ text: PRIVATE_MESSAGE, files: [sharedPrivateImage()] });
    mockSearchContacts.mockResolvedValue([{ name: PRIVATE_NAME, address: PRIVATE_ADDRESS }]);
    mockFindChat.mockResolvedValue(PRIVATE_EXISTING_GUID);
    mockCreateNewChat.mockResolvedValue(PRIVATE_CREATED_GUID);
    const view = await renderWithTheme(<NewChatScreen />);

    expect(screen.getByDisplayValue(PRIVATE_MESSAGE)).toBeTruthy();
    expectImageUriHost(view.toJSON());
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), PRIVATE_QUERY);
    });
    expect(screen.getByDisplayValue(PRIVATE_QUERY)).toBeTruthy();
    expect(await screen.findByText(PRIVATE_NAME)).toBeTruthy();
    expect(screen.getByText(PRIVATE_ADDRESS)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText(PRIVATE_NAME));
    });
    expect(screen.getByText(`${PRIVATE_NAME} ✕`)).toBeTruthy();
    expect(screen.getByLabelText(`Remove ${PRIVATE_NAME}`)).toBeTruthy();

    const existing = await screen.findByText(/Open it/);
    await fireEvent.press(existing);
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`);
    mockReplace.mockClear();

    await fireEvent.press(screen.getByRole('radio', { name: 'Send as SMS' }));
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText('Add a message (optional)'),
        PRIVATE_MESSAGE,
      );
    });
    await fireEvent.press(screen.getByText('Start'));

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [PRIVATE_ADDRESS],
        PRIVATE_MESSAGE,
        'SMS',
        expect.anything(),
      ),
    );
    const accountLease = mockCreateNewChat.mock.calls[0]?.[3];
    await waitFor(() =>
      expect(mockSendImages).toHaveBeenCalledWith(
        { chatGuid: PRIVATE_CREATED_GUID, images: [sharedPrivateImage()] },
        accountLease,
      ),
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_CREATED_GUID)}`);
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_URI);
  });
});

describe('NewChatScreen — account ownership and handoff lifetime', () => {
  it('does not consume external state for an initially stale account, then a fresh mount adopts it', async () => {
    const release = jest.fn();
    const clearShareIntent = jest.fn(() => useShareIntentStore.setState({ text: null, files: [] }));
    stageProtectedForward(release);
    useShareIntentStore.setState({
      text: PRIVATE_MESSAGE,
      files: [sharedPrivateImage()],
      clear: clearShareIntent,
    });
    await pauseRealtimeDeliveries();

    const staleView = await renderWithTheme(<NewChatScreen />);
    expectAccountChangedComposer(staleView.toJSON());
    expect(keyboardDismissSpy).toHaveBeenCalled();
    expect(clearShareIntent).not.toHaveBeenCalled();
    expect(mockFileInfoReads).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(mockSearchContacts).toHaveBeenCalledTimes(1);
    expect(mockSearchContacts).toHaveBeenCalledWith(undefined, '', 30);
    expect(mockCheckAvailability).not.toHaveBeenCalled();
    expect(mockFindChat).not.toHaveBeenCalled();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockSendImages).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('‹ Back'));
    expect(mockBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleView.unmount();
    });
    resumeRealtimeDeliveries();
    const currentView = await renderWithTheme(<NewChatScreen />);
    await waitFor(() => expectImageUriHost(currentView.toJSON(), FORWARD_URI));
    expect(screen.getByDisplayValue(PRIVATE_MESSAGE)).toBeTruthy();
    expectImageUriHost(currentView.toJSON(), PRIVATE_URI);
    expect(mockFileInfoReads).toEqual([`exists:${FORWARD_URI}`, `size:${FORWARD_URI}`]);
    expect(clearShareIntent).toHaveBeenCalledTimes(1);
    expect(useShareIntentStore.getState()).toMatchObject({ text: null, files: [] });
    expect(release).not.toHaveBeenCalled();

    await act(async () => {
      currentView.unmount();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('automatically retires A host, blocks retained external actions, and fresh B stays exact', async () => {
    useShareIntentStore.setState({ text: PRIVATE_MESSAGE, files: [sharedPrivateImage()] });
    mockSearchContacts.mockResolvedValue([
      { name: PRIVATE_NAME, address: PRIVATE_ADDRESS },
      { name: SECOND_NAME, address: SECOND_ADDRESS },
    ]);
    mockFindChat.mockResolvedValue(PRIVATE_EXISTING_GUID);
    mockCreateNewChat.mockResolvedValue(SECOND_CREATED_GUID);
    const oldView = await renderWithTheme(<NewChatScreen />);

    await fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), PRIVATE_QUERY);
    await fireEvent.press(await screen.findByText(PRIVATE_NAME));
    await screen.findByText(/Open it/);
    await fireEvent.changeText(screen.getByPlaceholderText('Add another…'), SECOND_ADDRESS);
    const oldToInput = screen.getByPlaceholderText('Add another…');
    const oldToChange = oldToInput.props.onChangeText as (text: string) => void;
    const oldToSubmit = oldToInput.props.onSubmitEditing as () => void;
    const oldMessageChange = screen.getByPlaceholderText('Add a message (optional)').props
      .onChangeText as (text: string) => void;
    const oldChip = retainConfiguredPress(screen.getByLabelText(`Remove ${PRIVATE_NAME}`));
    const oldAttachment = retainConfiguredPress(screen.getByLabelText('Remove attachment'));
    const oldSms = retainConfiguredPress(screen.getByRole('radio', { name: 'Send as SMS' }));
    const oldSuggestion = retainConfiguredPress(await screen.findByText(SECOND_NAME));
    const oldExisting = retainConfiguredPress(screen.getByText(/Open it/));
    const oldStart = retainConfiguredPress(screen.getByRole('button', { name: 'Start' }));

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    expectAccountChangedComposer(oldView.toJSON());
    expect(keyboardDismissSpy).toHaveBeenCalled();

    resumeRealtimeDeliveries();
    await act(async () => {
      oldToChange('+15550001111');
      oldToSubmit();
      oldMessageChange('retired-A-message-must-not-land');
      oldChip();
      oldAttachment();
      oldSms();
      oldSuggestion();
      oldExisting();
      oldStart();
      await Promise.resolve();
    });
    expectAccountChangedComposer(oldView.toJSON());
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockSendImages).not.toHaveBeenCalled();

    await act(async () => {
      oldView.unmount();
    });
    mockSearchParams = { forwardText: SECOND_MESSAGE };
    const currentView = await renderWithTheme(<NewChatScreen />);
    await addRecipient(SECOND_ADDRESS);
    const freshExisting = await screen.findByText(/Open it/);
    await fireEvent.press(freshExisting);
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`);
    mockReplace.mockClear();
    await fireEvent.press(screen.getByRole('radio', { name: 'Send as SMS' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [SECOND_ADDRESS],
        SECOND_MESSAGE,
        'SMS',
        expect.anything(),
      ),
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(SECOND_CREATED_GUID)}`);
    expect(currentView.toJSON()).not.toBeNull();
  });

  it.each(['success', 'rejection'] as const)(
    'keeps a fresh account availability result when retired A settles with %s',
    async (outcome) => {
      const oldProbe = deferred<boolean>();
      const freshProbe = deferred<boolean>();
      mockCheckAvailability
        .mockReturnValueOnce(oldProbe.promise)
        .mockReturnValueOnce(freshProbe.promise);
      mockSearchParams = { forwardText: PRIVATE_MESSAGE };
      mockCreateNewChat.mockResolvedValue(SECOND_CREATED_GUID);
      const oldView = await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(1));

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expectAccountChangedComposer(oldView.toJSON());
      resumeRealtimeDeliveries();
      const currentView = await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(2));
      await act(async () => {
        freshProbe.resolve(false);
        await freshProbe.promise;
      });
      expect(screen.getByLabelText(`Remove ${PRIVATE_ADDRESS} (SMS only)`)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldProbe.resolve(true);
        else oldProbe.reject(new Error('retired-availability-error-c8c1'));
        await oldProbe.promise.catch(() => undefined);
      });
      expect(screen.getByLabelText(`Remove ${PRIVATE_ADDRESS} (SMS only)`)).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() =>
        expect(mockCreateNewChat).toHaveBeenCalledWith(
          [PRIVATE_ADDRESS],
          PRIVATE_MESSAGE,
          'SMS',
          expect.anything(),
        ),
      );
      expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(SECOND_CREATED_GUID)}`);
      expect(currentView.toJSON()).not.toBeNull();
    },
  );

  it.each(['success', 'rejection'] as const)(
    'keeps fresh B existing-chat routing when retired A lookup settles with %s',
    async (outcome) => {
      const oldLookup = deferred<string | null>();
      const freshLookup = deferred<string | null>();
      mockFindChat.mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(freshLookup.promise);
      const oldView = await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(1));

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expectAccountChangedComposer(oldView.toJSON());
      resumeRealtimeDeliveries();
      await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(2));
      await act(async () => {
        freshLookup.resolve(PRIVATE_EXISTING_GUID);
        await freshLookup.promise;
      });
      expect(await screen.findByText(/Open it/)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldLookup.resolve('iMessage;-;retired-A-match-39e4');
        else oldLookup.reject(new Error('retired-existing-error-0aca'));
        await oldLookup.promise.catch(() => undefined);
      });
      const freshOpen = screen.getByText(/Open it/);
      await fireEvent.press(freshOpen);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith(
        `/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`,
      );
    },
  );

  it.each(['success', 'rejection'] as const)(
    'suppresses retired A attachment-send %s and a fresh B send remains exact',
    async (outcome) => {
      const release = jest.fn();
      const sending = deferred<unknown>();
      const rawError = 'retired-A-send-error-6d8b';
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      stageProtectedForward(release);
      mockCreateNewChat
        .mockResolvedValueOnce(PRIVATE_CREATED_GUID)
        .mockResolvedValueOnce(SECOND_CREATED_GUID);
      mockSendImages.mockReturnValueOnce(sending.promise).mockResolvedValueOnce([]);
      const oldView = await renderWithTheme(<NewChatScreen />);
      await waitFor(() => expectImageUriHost(oldView.toJSON(), FORWARD_URI));
      await addRecipient(PRIVATE_ADDRESS);
      await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(mockSendImages).toHaveBeenCalledTimes(1));
      const oldLease = mockCreateNewChat.mock.calls[0]?.[3];

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expectAccountChangedComposer(oldView.toJSON());
      await act(async () => {
        if (outcome === 'success') sending.resolve([]);
        else sending.reject(new Error(rawError));
        await sending.promise.catch(() => undefined);
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(useDialogStore.getState().current).toBeNull();
      expect(mockReplace).not.toHaveBeenCalled();
      expect(JSON.stringify(oldView.toJSON())).not.toContain(rawError);
      if (outcome === 'success') expect(release).toHaveBeenCalledTimes(1);
      else expect(release).not.toHaveBeenCalled();

      await act(async () => {
        oldView.unmount();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(release).toHaveBeenCalledTimes(1);
      resumeRealtimeDeliveries();
      useShareIntentStore.setState({ text: SECOND_MESSAGE, files: [sharedPrivateImage()] });
      const currentView = await renderWithTheme(<NewChatScreen />);
      await addRecipient(SECOND_ADDRESS);
      await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(mockSendImages).toHaveBeenCalledTimes(2));
      const currentLease = mockCreateNewChat.mock.calls[1]?.[3];
      expect(currentLease).not.toBe(oldLease);
      expect(mockSendImages).toHaveBeenLastCalledWith(
        { chatGuid: SECOND_CREATED_GUID, images: [sharedPrivateImage()] },
        currentLease,
      );
      expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(SECOND_CREATED_GUID)}`);
      expect(currentView.toJSON()).not.toBeNull();
    },
  );

  it('retains a protected attachment after a current failure, then retries and releases it', async () => {
    const release = jest.fn();
    const rawError = 'current-send-error-b740';
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    stageProtectedForward(release);
    mockCreateNewChat.mockResolvedValue(PRIVATE_CREATED_GUID);
    mockSendImages.mockRejectedValueOnce(new Error(rawError)).mockResolvedValueOnce([]);
    const view = await renderWithTheme(<NewChatScreen />);
    await waitFor(() => expectImageUriHost(view.toJSON(), FORWARD_URI));
    await addRecipient(PRIVATE_ADDRESS);
    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toBe(
      'Couldn’t start the conversation. Check the address and your server connection.',
    );
    expect(errorSpy).toHaveBeenCalledWith('[new-chat] createNewChat failed', expect.any(Error));
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
    expect(release).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(PRIVATE_MESSAGE)).toBeTruthy();
    expectImageUriHost(view.toJSON(), FORWARD_URI);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState).toEqual({
        disabled: false,
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mockSendImages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_CREATED_GUID)}`);
  });

  it('releases an adopted handoff after a successful text-only send removes its staged row', async () => {
    const release = jest.fn();
    stageProtectedForward(release);
    mockCreateNewChat.mockResolvedValue(PRIVATE_CREATED_GUID);
    const view = await renderWithTheme(<NewChatScreen />);
    await waitFor(() => expectImageUriHost(view.toJSON(), FORWARD_URI));
    await addRecipient(PRIVATE_ADDRESS);
    await fireEvent.press(screen.getByLabelText('Remove attachment'));
    expect(release).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain(FORWARD_URI);
    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mockSendImages).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_CREATED_GUID)}`);
  });
});

describe('NewChatScreen — validation', () => {
  it('does not create a chat when there is no recipient', async () => {
    await renderWithTheme(<NewChatScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    // Give any (guarded) async path a tick to run, then assert nothing fired.
    await waitFor(() => expect(mockCreateNewChat).not.toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('NewChatScreen — existing conversation', () => {
  it('offers to open an existing chat with the same recipients', async () => {
    mockFindChat.mockResolvedValue('iMessage;-;existing');
    await renderWithTheme(<NewChatScreen />);

    const toInput = screen.getByPlaceholderText('Phone or email');
    await act(async () => {
      fireEvent.changeText(toInput, '+15559999999');
    });
    await act(async () => {
      fireEvent(toInput, 'submitEditing');
    });

    const banner = await screen.findByText(/Open it/);
    await act(async () => {
      fireEvent.press(banner);
    });
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent('iMessage;-;existing')}`);
  });

  it('hides a resolved A banner immediately while a new recipient-key lookup is pending', async () => {
    const pendingB = deferred<string | null>();
    mockFindChat
      .mockResolvedValueOnce('iMessage;-;existing-A')
      .mockReturnValueOnce(pendingB.promise);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551112222');
    await screen.findByText(/Open it/);

    // The old resolved value must disappear from render as soon as the exact recipient key changes,
    // before the new query has any result of its own.
    await addRecipient('+15553334444');
    await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Open it/)).toBeNull();

    await act(async () => {
      pendingB.resolve(null);
      await pendingB.promise;
    });
    await waitFor(() => expect(screen.queryByText(/Open it/)).toBeNull());
  });

  it.each(['success', 'rejection'] as const)(
    'keeps a fresh same-key match when a cleaned-up lookup settles with %s',
    async (outcome) => {
      const oldLookup = deferred<string | null>();
      const freshLookup = deferred<string | null>();
      mockFindChat.mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(freshLookup.promise);
      await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(1));

      await fireEvent.press(screen.getByLabelText(`Remove ${PRIVATE_ADDRESS}`));
      await waitFor(() => expect(screen.queryByText(`${PRIVATE_ADDRESS} ✕`)).toBeNull());
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(2));
      await act(async () => {
        freshLookup.resolve(PRIVATE_EXISTING_GUID);
        await freshLookup.promise;
      });
      expect(await screen.findByText(/Open it/)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldLookup.resolve('iMessage;-;stale-same-key-match-a714');
        else oldLookup.reject(new Error('stale-same-key-match-error-148c'));
        await oldLookup.promise.catch(() => undefined);
      });
      const freshOpen = screen.getByText(/Open it/);
      await fireEvent.press(freshOpen);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith(
        `/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`,
      );
    },
  );
});

describe('NewChatScreen — create failure', () => {
  it('shows fixed copy for a current failure, clears busy, and retries exactly', async () => {
    const rawError = 'new-chat-current-create-error-98c0';
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockCreateNewChat
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce(PRIVATE_CREATED_GUID);
    mockSearchParams = { forwardText: 'Hi' };
    const view = await renderWithTheme(<NewChatScreen />);

    const toInput = screen.getByPlaceholderText('Phone or email');
    await act(async () => {
      fireEvent.changeText(toInput, '+15551112222');
    });
    await act(async () => {
      fireEvent(toInput, 'submitEditing');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toBe(
      'Couldn’t start the conversation. Check the address and your server connection.',
    );
    expect(error).toHaveBeenCalledWith('[new-chat] createNewChat failed', expect.any(Error));
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState).toEqual({
        disabled: false,
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(2));
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_CREATED_GUID)}`);
  });

  it.each(['success', 'rejection'] as const)(
    'suppresses an admitted create %s after its account retires',
    async (outcome) => {
      const creating = deferred<string>();
      const rawError = 'new-chat-retired-create-error-1d3e';
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      mockCreateNewChat.mockReturnValueOnce(creating.promise);
      mockSearchParams = { forwardText: 'Old account message' };
      const oldView = await renderWithTheme(<NewChatScreen />);
      await addRecipient('+15551112222');

      await act(async () => {
        fireEvent.press(screen.getByText('Start'));
      });
      await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
      const accountLease = mockCreateNewChat.mock.calls[0]?.[3] as { isCurrent: () => boolean };
      expect(accountLease.isCurrent()).toBe(true);

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expectAccountChangedComposer(oldView.toJSON());
      await act(async () => {
        if (outcome === 'success') creating.resolve('iMessage;-;+15551112222');
        else creating.reject(new Error(rawError));
        await creating.promise.catch(() => undefined);
      });

      expect(mockSendImages).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      expect(useDialogStore.getState().current).toBeNull();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(oldView.toJSON())).not.toContain(rawError);
      expect(accountLease.isCurrent()).toBe(false);
      resumeRealtimeDeliveries();
    },
  );
});

/**
 * F2 (device-found, HIGH): Start used to require a COMMITTED chip, and the only things that
 * committed one were a trailing comma and `submitEditing`. So typing a number and pressing Start —
 * the obvious flow, and the one a user hits when the keyboard shows "Start" rather than a return
 * key — silently did nothing at all: no chat, no dialog, no log. Every pre-existing test in this
 * file fires `submitEditing` first, which is exactly why the suite was green while the screen was
 * broken. These lock the UNCOMMITTED path.
 *
 * The pending recipient is deliberately loose (the server is the real validator) but strict enough
 * that a half-typed contact NAME can never start a garbage chat — hence the negative cases.
 */
describe('NewChatScreen — Start works on a typed address that was never committed (F2)', () => {
  it('creates the chat from raw input with NO submitEditing and NO trailing comma', async () => {
    mockSearchParams = { forwardText: 'Hello there' };
    await renderWithTheme(<NewChatScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), '+15551234567');
    });
    // Deliberately NO submitEditing — this is the exact state that used to dead-end.
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551234567'],
        'Hello there',
        'iMessage',
        expect.anything(),
      ),
    );
  });

  it('accepts a raw email the same way', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), 'someone@example.com');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['someone@example.com'],
        'Hi',
        'iMessage',
        expect.anything(),
      ),
    );
  });

  it('tolerates a trailing comma without duplicating the recipient', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), '+15551234567,');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });

    // The comma commits a chip; the pending value must not ALSO be appended.
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
    expect(mockCreateNewChat.mock.calls[0]?.[0]).toEqual(['+15551234567']);
  });

  it('refuses a half-typed contact NAME — that would start a garbage chat', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), 'Aar');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });

    await waitFor(() => expect(mockCreateNewChat).not.toHaveBeenCalled());
  });

  it('refuses too-few digits and a malformed email', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);
    const toInput = screen.getByPlaceholderText('Phone or email');

    for (const bad of ['12345', 'nope@', '@nope.com', 'a@b']) {
      await act(async () => {
        fireEvent.changeText(toInput, bad);
      });
      await act(async () => {
        fireEvent.press(screen.getByText('Start'));
      });
      await waitFor(() => expect(mockCreateNewChat).not.toHaveBeenCalled());
    }
  });
});

/**
 * F21 (found by the F2 tests above, pre-existing): the comma branch of `onChangeText` resolved the
 * recipient from the PREVIOUS `query` state and never called `setQuery`, so a single change event
 * carrying both the address and the comma — i.e. a PASTE — committed nothing and erased the field.
 * Typing character-by-character masked it because `query` was already populated by then.
 */
describe('NewChatScreen — a pasted comma-terminated address (F21)', () => {
  it('commits a pasted "address," instead of silently erasing it', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    // ONE event carrying address + comma, exactly what a paste produces.
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), '+15551234567,');
    });

    expect(await screen.findByText('+15551234567 ✕')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
    expect(mockCreateNewChat.mock.calls[0]?.[0]).toEqual(['+15551234567']);
  });

  it('keeps non-addressable text visible (minus the comma) rather than dropping it', async () => {
    await renderWithTheme(<NewChatScreen />);
    const toInput = screen.getByPlaceholderText('Phone or email');

    await act(async () => {
      fireEvent.changeText(toInput, 'Aar,');
    });

    // Still in the field for the user to finish typing — not silently wiped.
    await waitFor(() => expect(toInput.props.value).toBe('Aar'));
    expect(screen.queryByText('Aar ✕')).toBeNull();
  });

  it('still commits char-by-char typing followed by a comma', async () => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);
    const toInput = screen.getByPlaceholderText('Phone or email');

    await act(async () => {
      fireEvent.changeText(toInput, '+15551234567');
    });
    await act(async () => {
      fireEvent.changeText(toInput, '+15551234567,');
    });

    expect(await screen.findByText('+15551234567 ✕')).toBeTruthy();
  });
});
