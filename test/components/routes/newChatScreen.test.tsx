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
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import type { ContactPick } from '@db/repositories';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams: { forwardText?: string; forwardAttachments?: string } = {};
// Per-uri fake filesystem for the forwarded-attachment validation (File.exists/.size).
// Referenced LAZILY from the mock class's getters (safe under factory hoisting, like
// mockSearchParams), and reset in beforeEach.
const mockFiles: Record<string, { exists: boolean; size: number | null }> = {};

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
  File: class {
    private readonly mockUri: string;
    constructor(uri: string) {
      this.mockUri = uri;
    }
    get exists(): boolean {
      return mockFiles[this.mockUri]?.exists ?? false;
    }
    get size(): number | null {
      return mockFiles[this.mockUri]?.size ?? null;
    }
  },
}));
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

const mockCreateNewChat = createNewChat as jest.Mock;
const mockSendImages = sendImages as jest.Mock;
const mockSearchContacts = searchContactAddresses as jest.Mock;
const mockFindChat = findChatByParticipantAddresses as jest.Mock;
const mockCheckAvailability = checkIMessageAvailability as jest.Mock;

beforeEach(() => {
  mockSearchParams = {};
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockSendImages.mockResolvedValue([]);
  mockSearchContacts.mockResolvedValue([] as ContactPick[]);
  mockFindChat.mockResolvedValue(null);
  mockCreateNewChat.mockResolvedValue('iMessage;-;+15551234567');
  // Default: no probe resolves (helper down) → chips stay neutral, service stays iMessage.
  mockCheckAvailability.mockRejectedValue(new Error('no helper'));
  useDialogStore.setState({ current: null, queue: [] });
  // Default: no server capabilities → the RCS chip is hidden.
  useSessionStore.setState({ serverInfo: null });
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
      expect(mockCreateNewChat).toHaveBeenCalledWith(['+15551230000'], 'hi', 'SMS'),
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
      expect(mockCreateNewChat).toHaveBeenCalledWith(['+15551230000'], 'hi', 'RCS'),
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
      expect(mockCreateNewChat).toHaveBeenCalledWith(['+15551230000'], 'hi', 'RCS'),
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
    const uri = 'file:///data/att/IMG_0001.jpeg';
    mockFiles[uri] = { exists: true, size: 1234 };
    mockSearchParams = {
      forwardAttachments: JSON.stringify([{ uri, name: 'IMG_0001.jpeg', mimeType: 'image/jpeg' }]),
    };
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
      expect(mockSendImages).toHaveBeenCalledWith({
        chatGuid: 'iMessage;-;+15551234567',
        images: [{ uri, name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', size: 1234 }],
      }),
    );
  });

  it('does not stage a forwarded attachment whose file is missing on disk', async () => {
    mockSearchParams = {
      forwardText: 'still forwards the text',
      forwardAttachments: JSON.stringify([
        { uri: 'file:///data/att/gone.jpeg', name: 'gone.jpeg', mimeType: 'image/jpeg' },
      ]),
    };
    await renderWithTheme(<NewChatScreen />);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
    expect(screen.getByPlaceholderText('Message').props.value).toBe('still forwards the text');
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
      expect(mockCreateNewChat).toHaveBeenCalledWith(['+15551234567'], 'Hello there', 'iMessage'),
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

  it('clears a stale banner when the lookup rejects', async () => {
    mockFindChat.mockResolvedValueOnce('iMessage;-;existing');
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551112222');
    await screen.findByText(/Open it/);

    // The next lookup (recipients changed) fails → the stale banner must clear, not linger.
    mockFindChat.mockRejectedValueOnce(new Error('db closed'));
    await addRecipient('+15553334444');
    await waitFor(() => expect(screen.queryByText(/Open it/)).toBeNull());
  });
});

describe('NewChatScreen — create failure', () => {
  it('shows a dialog when the create fails', async () => {
    mockCreateNewChat.mockRejectedValue(new Error('server down'));
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

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
  });
});
