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
import { ApiError } from '@core/api/errors';
import type { ContactPick, ExistingChatMatch } from '@db/repositories';
import { getDatabase } from '@db/database';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockRouter = { push: mockPush, back: mockBack, replace: mockReplace };
let mockSearchParams: {
  forwardText?: string;
  forwardAttachmentHandoff?: string;
  shareBatch?: string;
  /** Legacy/public payload retained only to prove the route ignores it. */
  forwardAttachments?: string;
} = {};
let mockUnsavedChangesOptions:
  | {
      enabled: boolean;
      onDiscard?: () => void | boolean | Promise<void | boolean>;
      onAfterDiscardNavigation?: () => void;
      title?: string;
      message?: string;
      blocked?: { readonly title: string; readonly message: string } | null;
    }
  | undefined;
const mockNavigateWithoutPrompt = jest.fn((navigate: () => void): void => navigate());
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
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams,
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
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
jest.mock('@/services', () => ({
  addTextToChatDraft: jest.fn(),
  createNewChat: jest.fn(),
  http: {},
}));
jest.mock('@/services/send', () => ({ send: jest.fn(), sendImages: jest.fn() }));
jest.mock('@/services/share/shareIntake', () => ({
  consumeShareIntakeBatchIfComplete: jest.fn(),
  discardShareIntakeItem: jest.fn(() => Promise.resolve()),
  discardShareIntakeBatch: jest.fn(),
  drainShareIntake: jest.fn(() => Promise.resolve()),
  isShareIntakeFileSettled: jest.fn(
    (receipt: { items?: Record<string, unknown> } | null, index: number) =>
      receipt?.items?.[`file:${String(index).padStart(2, '0')}`] != null,
  ),
  isShareIntakeNewChatRetryWindowOpen: jest.fn(
    (identity: { nativeCreatedAtMs: number }, nowMs = Date.now()) =>
      nowMs >= identity.nativeCreatedAtMs &&
      nowMs - identity.nativeCreatedAtMs < 30 * 24 * 60 * 60 * 1_000,
  ),
  isShareIntakeReceiptComplete: jest.fn(),
  prepareShareIntakeNewChatPlan: jest.fn(async (_identity: unknown, plan: unknown) => plan),
  readShareIntakeReceipt: jest.fn(),
}));
jest.mock('@ui/hooks/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: (options: typeof mockUnsavedChangesOptions) => {
    mockUnsavedChangesOptions = options;
    return { navigateWithoutPrompt: mockNavigateWithoutPrompt };
  },
}));
jest.mock('@core/api/endpoints/handles', () => ({ checkIMessageAvailability: jest.fn() }));
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  searchContactAddresses: jest.fn(),
  findChatsByParticipantAddresses: jest.fn(),
}));

// eslint-disable-next-line import/first
import NewChatScreen from '../../../app/(app)/new-chat';
// eslint-disable-next-line import/first
import * as Crypto from 'expo-crypto';
// eslint-disable-next-line import/first
import { addTextToChatDraft, createNewChat } from '@/services';
// eslint-disable-next-line import/first
import { send, sendImages } from '@/services/send';
// eslint-disable-next-line import/first
import { checkIMessageAvailability } from '@core/api/endpoints/handles';
// eslint-disable-next-line import/first
import {
  consumeShareIntakeBatchIfComplete,
  discardShareIntakeBatch,
  drainShareIntake,
  isShareIntakeReceiptComplete,
  prepareShareIntakeNewChatPlan,
  readShareIntakeReceipt,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { presentSendIssue } from '@ui/conversations/sendNotices';
// eslint-disable-next-line import/first
import {
  searchContactAddresses,
  findChatsByParticipantAddresses,
  SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS,
} from '@db/repositories';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { MAX_RCS_ATTACHMENT_UPLOAD_BYTES, ServerInfo } from '@core/models';
// eslint-disable-next-line import/first
import { useShareIntentStore } from '@state/shareIntentStore';
// eslint-disable-next-line import/first
import {
  clearForwardAttachmentHandoffs,
  stageForwardAttachmentHandoff,
} from '@features/conversations/forwardAttachmentHandoff';

const mockCreateNewChat = createNewChat as jest.Mock;
const mockCheckAvailability = checkIMessageAvailability as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockRandomUUID = Crypto.randomUUID as jest.Mock;
const mockSendImages = sendImages as jest.Mock;
const mockSend = send as jest.Mock;
const mockAddTextToChatDraft = addTextToChatDraft as jest.Mock;
const mockConsumeShareIntakeBatchIfComplete = consumeShareIntakeBatchIfComplete as jest.Mock;
const mockDiscardShareIntakeBatch = discardShareIntakeBatch as jest.Mock;
const mockDrainShareIntake = drainShareIntake as jest.Mock;
const mockSearchContacts = searchContactAddresses as jest.Mock;
const mockFindChat = findChatsByParticipantAddresses as jest.Mock;
const mockGetShareIntakeReceipt = readShareIntakeReceipt as jest.Mock;
const mockIsShareIntakeReceiptComplete = isShareIntakeReceiptComplete as jest.Mock;
const mockPrepareSharePlan = prepareShareIntakeNewChatPlan as jest.Mock;
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
const PRIVATE_CREATED_GUID = 'RCS;-;new-chat-private-created-d913';
const SECOND_CREATED_GUID = 'RCS;-;new-chat-current-created-471a';
const PRIVATE_SHARE_BATCH = '1700000000000-1-0123456789abcdef';
const SECOND_SHARE_BATCH = '1700000000001-2-fedcba9876543210';
const ACCOUNT_CHANGED_COPY = 'Account changed. Go back and start a new message again.';
const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
// Plain RCS starts carry one stable request id per draft (from the mocked random UUID).
const STABLE_RCS_ATTEMPT_ID = 'temp-00000000-0000-4000-8000-000000000001';
const UNCONFIRMED_RCS_COPY =
  'Gator could not confirm whether the first RCS message was sent. Check Google Messages before trying again. Your draft is still here.';
const RCS_SERVER_IDENTITY = {
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: RCS_PROVIDER_EPOCH,
} as const;
const rcsServerInfo = ServerInfo.parse({
  version: '1.9.0',
  private_api: true,
  rcs: true,
  supports_rcs_send_attempt_ownership: true,
  ...RCS_SERVER_IDENTITY,
});
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

/** An existing chat as the finder reports it (one-to-one unless overridden). */
function existing(guid: string, overrides: Partial<ExistingChatMatch> = {}): ExistingChatMatch {
  return { guid, latestMessageDate: null, name: null, isGroup: false, ...overrides };
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
    origin: 'share' as const,
    shareItemIndex: 0,
  };
}

function stageShare(
  batchId: string,
  text: string | null = PRIVATE_MESSAGE,
  files = [sharedPrivateImage()],
): void {
  mockSearchParams = { ...mockSearchParams, shareBatch: batchId };
  useShareIntentStore.setState({
    batchId,
    createdAtMs: Date.now(),
    text,
    files,
    targetToken: null,
    failureReason: null,
  });
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
  mockNavigateWithoutPrompt.mockReset().mockImplementation((navigate) => navigate());
  clearForwardAttachmentHandoffs();
  resumeRealtimeDeliveries();
  mockSearchParams = {};
  mockUnsavedChangesOptions = undefined;
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFileInfoReads.length = 0;
  mockSendImages.mockReset().mockResolvedValue([]);
  // The real send reports queue admission before its network round trip completes.
  mockSend
    .mockReset()
    .mockImplementation(
      (
        _args: unknown,
        _lease: unknown,
        _report: unknown,
        onQueued?: (tempGuid: string) => void,
      ) => {
        onQueued?.('temp-existing-send');
        return Promise.resolve({ tempGuid: 'temp-existing-send' });
      },
    );
  mockAddTextToChatDraft.mockReset().mockResolvedValue(undefined);
  mockGetDatabase.mockReset();
  mockConsumeShareIntakeBatchIfComplete.mockReset().mockResolvedValue(true);
  mockDiscardShareIntakeBatch.mockReset().mockResolvedValue(true);
  mockDrainShareIntake.mockClear();
  mockSearchContacts.mockReset().mockResolvedValue([] as ContactPick[]);
  mockFindChat.mockReset().mockResolvedValue([]);
  mockGetShareIntakeReceipt.mockReset().mockResolvedValue(null);
  mockIsShareIntakeReceiptComplete.mockReset().mockReturnValue(false);
  mockPrepareSharePlan
    .mockReset()
    .mockImplementation(async (_identity: unknown, plan: unknown) => plan);
  mockCreateNewChat.mockReset().mockResolvedValue('RCS;-;+15551234567');
  mockRandomUUID.mockReset().mockReturnValue('00000000-0000-4000-8000-000000000001');
  useDialogStore.setState({ current: null, queue: [] });
  useShareIntentStore.setState({
    batchId: null,
    createdAtMs: null,
    text: null,
    files: [],
    targetToken: null,
    failureReason: null,
    clear: clearShareIntentStore,
  });
  keyboardDismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  useSessionStore.setState({ serverInfo: rcsServerInfo });
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

describe('NewChatScreen — opening an existing conversation', () => {
  const openIt = async (): Promise<void> => {
    await fireEvent.press(await screen.findByRole('button', { name: /Open it/ }));
  };
  beforeEach(() => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    mockFindChat.mockResolvedValue([existing(PRIVATE_EXISTING_GUID)]);
  });

  it('marks the share it shows as owned while open, and releases it on close', async () => {
    stageShare(SECOND_SHARE_BATCH);
    const view = await renderWithTheme(<NewChatScreen />);
    expect(useShareIntentStore.getState().owners).toBe(1);

    await view.unmount();
    expect(useShareIntentStore.getState().owners).toBe(0);
  });

  it('owns no share when its route names none, even while one is held', async () => {
    useShareIntentStore.setState({
      batchId: SECOND_SHARE_BATCH,
      createdAtMs: Date.now(),
      text: null,
      files: [],
      targetToken: null,
      owners: 0,
    });
    await renderWithTheme(<NewChatScreen />);
    expect(useShareIntentStore.getState().owners).toBe(0);
  });

  it('opens it with a shared item, keeping the share instead of asking to discard it', async () => {
    stageShare(SECOND_SHARE_BATCH);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await openIt();

    expect(mockNavigateWithoutPrompt).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}?shareBatch=${encodeURIComponent(SECOND_SHARE_BATCH)}`,
    );
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();
  });

  it('opens it without asking when only the recipient was chosen', async () => {
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await openIt();

    expect(mockNavigateWithoutPrompt).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`);
  });

  it('keeps typed text as that chat’s draft and opens it without asking', async () => {
    await renderWithTheme(<NewChatScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), '  Typed before choosing ');
    });
    await addRecipient(PRIVATE_ADDRESS);

    await openIt();

    await waitFor(() => expect(mockNavigateWithoutPrompt).toHaveBeenCalledTimes(1));
    expect(mockAddTextToChatDraft).toHaveBeenCalledWith(
      PRIVATE_EXISTING_GUID,
      'Typed before choosing',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(mockAddTextToChatDraft.mock.invocationCallOrder[0]!).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0]!,
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`);
  });

  it('keeps the text but leaves the discard question to the guard for a forwarded file', async () => {
    stageProtectedForward(jest.fn());
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await openIt();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockAddTextToChatDraft).toHaveBeenCalledWith(
      PRIVATE_EXISTING_GUID,
      PRIVATE_MESSAGE,
      expect.anything(),
    );
    // The real guard asks "Discard new message?" for this replace, because the file stays behind.
    expect(mockNavigateWithoutPrompt).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_EXISTING_GUID)}`);
  });

  it('stays, with the text still here, when the draft cannot be kept', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockAddTextToChatDraft.mockRejectedValueOnce(new Error('disk full'));
    await renderWithTheme(<NewChatScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'Typed before choosing');
    });
    await addRecipient(PRIVATE_ADDRESS);

    await openIt();

    await waitFor(() =>
      expect(useDialogStore.getState().current?.message).toBe(
        'Couldn’t keep your message as that conversation’s draft. It is still here.',
      ),
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Typed before choosing')).toBeTruthy();
  });
});

describe('NewChatScreen — Start adds to an existing conversation', () => {
  beforeEach(() => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        supports_imessage_new_chat: true,
        supports_imessage_plain_text: true,
      }),
    });
  });

  const typeMessage = async (text: string): Promise<void> => {
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), text);
    });
  };
  const pressStart = async (): Promise<void> => {
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
  };

  it('sends into the existing one-to-one chat through the normal send path and opens it', async () => {
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999', { latestMessageDate: 1 })]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');
    await typeMessage(' hello ');
    expect(
      await screen.findByText('Start sends your message to the existing conversation.'),
    ).toBeTruthy();

    await pressStart();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith(
      { chatGuid: 'any;-;+15559999999', text: 'hello' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockNavigateWithoutPrompt).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent('any;-;+15559999999')}`);
  });

  it('sends to a group through Open it, which keeps the message as the group’s draft', async () => {
    const now = Date.now();
    mockFindChat.mockResolvedValue([
      existing('any;+;chat-new', { name: 'Weekend', latestMessageDate: now, isGroup: true }),
      existing('any;+;chat-old', { name: 'Old plans', latestMessageDate: now - 1, isGroup: true }),
    ]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551112222');
    await addRecipient('+15553334444');
    await typeMessage('hello group');
    await fireEvent.press(await screen.findByRole('radio', { name: /^Old plans · / }));

    // A group's send has no exact acknowledgement, so Start stays off and Open it carries the text.
    expect(
      screen.getByText(
        'To send to this group, choose Open it. Your message goes with you as a draft.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/one-to-one/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
    await fireEvent.press(screen.getByRole('button', { name: /Open it/ }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockAddTextToChatDraft).toHaveBeenCalledWith(
      'any;+;chat-old',
      'hello group',
      expect.anything(),
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent('any;+;chat-old')}`);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('creates as before when the server has no exact iMessage text route', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    mockCreateNewChat.mockResolvedValue('any;-;+15559999999');
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999')]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');
    await typeMessage('hello');
    expect(screen.queryByText('Start sends your message to the existing conversation.')).toBeNull();

    await pressStart();

    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('stays with the message when the send is refused before it was queued', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockSend.mockRejectedValueOnce(new Error('capability changed'));
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999')]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');
    await typeMessage('hello');

    await pressStart();

    await waitFor(() =>
      expect(useDialogStore.getState().current?.message).toBe(
        'Couldn’t send to that conversation. Your message is still here.',
      ),
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('hello')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
        false,
      ),
    );
  });

  it('never sends to the chat found for the chosen people while another address is half-typed', async () => {
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999')]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');
    await typeMessage('hello');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Add another…'), '+15558888888');
    });

    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
    await pressStart();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('keeps a share on its own path: Start never sends it into a found chat', async () => {
    stageShare(PRIVATE_SHARE_BATCH, 'shared text', []);
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999')]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');

    expect(await screen.findByRole('button', { name: /Open it/ })).toBeTruthy();
    expect(screen.queryByText('Start sends your message to the existing conversation.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
    await pressStart();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('NewChatScreen — leaving while the send runs', () => {
  it('blocks Back with one neutral wait message instead of a discard prompt', async () => {
    const creating = deferred<string>();
    mockCreateNewChat.mockReturnValueOnce(creating.promise);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    expect(mockUnsavedChangesOptions?.blocked).toBeNull();
    expect(mockUnsavedChangesOptions?.title).toBe('Discard new message?');

    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));

    const waitMessage = {
      title: 'Still starting the conversation',
      message: 'Wait for the send to finish before leaving this screen.',
    };
    expect(mockUnsavedChangesOptions?.blocked).toEqual(waitMessage);
    // A discard confirmed in the instant before the send began still refuses, with the same copy.
    await act(async () => {
      await expect(mockUnsavedChangesOptions?.onDiscard?.()).resolves.toBe(false);
    });
    expect(useDialogStore.getState().current).toMatchObject(waitMessage);

    await act(async () => {
      creating.resolve('RCS;-;+15551230000');
      await creating.promise;
    });
  });
});

describe('NewChatScreen — service-scoped creation boundary', () => {
  it('creates one RCS conversation when the authoritative capability is available', async () => {
    await renderWithTheme(<NewChatScreen />);
    expect(screen.getByText(/New conversations use RCS/)).toBeTruthy();
    expect(screen.queryByText('iMessage')).toBeNull();
    expect(screen.queryByText('SMS')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await addRecipient('+15551230000');
    expect(mockFindChat).not.toHaveBeenCalled();
    expect(screen.queryByText(/Open it/)).toBeNull();
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
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
      ),
    );
  });

  it('keeps an RCS draft and its exact request id for retry after an uncertain failure', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockCreateNewChat
      .mockRejectedValueOnce(new ApiError('timeout', 'Request timed out'))
      .mockResolvedValueOnce('RCS;-;+15551230000');
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'keep this draft');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toContain(
      'could not confirm whether the first RCS message was sent',
    );
    expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(2));
    expect(mockCreateNewChat.mock.calls[0]?.[3]).toBe('RCS');
    expect(mockCreateNewChat.mock.calls[0]?.[4]).toMatch(/^temp-/);
    expect(mockCreateNewChat.mock.calls[1]?.[4]).toBe(mockCreateNewChat.mock.calls[0]?.[4]);
  });

  it('reports a known RCS refusal as not started', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockCreateNewChat.mockRejectedValueOnce(
      ApiError.fromStatus(400, 'invalid', undefined, 'validation'),
    );
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toBe(
      'Couldn’t start the conversation. Check the address and your server connection.',
    );
  });

  it('blocks a multi-recipient create and unblocks after returning to one recipient', async () => {
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await addRecipient('+15559990000');
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
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
      ),
    );
  });

  it('does not restore helper creation from an injected private_api:true flag', async () => {
    useSessionStore.setState({
      serverInfo: {
        ...ServerInfo.parse({ version: '1.9.0', rcs: false }),
        private_api: true,
      },
    });
    await renderWithTheme(<NewChatScreen />);

    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText('iMessage')).toBeNull();
    expect(screen.queryByText('SMS')).toBeNull();
    expect(screen.getByText(/requires an available RCS bridge/)).toBeTruthy();
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
      fireEvent.press(screen.getByText('Start'));
    });

    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('lets the user explicitly choose an advertised iMessage path without changing the RCS default', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        rcs: true,
        ...RCS_SERVER_IDENTITY,
        supports_imessage_new_chat: true,
        private_api: false,
      }),
    });
    mockCreateNewChat.mockResolvedValue('iMessage;-;+15551230000');
    await renderWithTheme(<NewChatScreen />);
    expect(screen.getByRole('radio', { name: 'RCS' }).props.accessibilityState.selected).toBe(true);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.press(screen.getByRole('radio', { name: 'iMessage' }));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hello');
    });
    await waitFor(() =>
      expect(mockFindChat).toHaveBeenLastCalledWith(undefined, ['+15551230000'], 'iMessage'),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
    expect(mockCreateNewChat).toHaveBeenCalledWith(
      ['+15551230000'],
      'hello',
      expect.anything(),
      'iMessage',
      'temp-00000000-0000-4000-8000-000000000001',
    );
    expect(mockReplace).toHaveBeenCalledWith('/chat/iMessage%3B-%3B%2B15551230000');
  });

  it('keeps an iMessage draft and the exact request id for retry after an uncertain failure', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    mockCreateNewChat
      .mockRejectedValueOnce(new Error('uncertain response'))
      .mockResolvedValueOnce('iMessage;-;+15551230000');
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'keep this draft');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toContain(
      'could not confirm whether the iMessage was sent',
    );
    expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(2));
    expect(mockCreateNewChat.mock.calls[0]?.[4]).toBe(mockCreateNewChat.mock.calls[1]?.[4]);
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
  });

  it('reports a known unavailable helper without suggesting the message may have been sent', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    mockCreateNewChat.mockRejectedValueOnce(
      ApiError.fromStatus(503, 'unavailable', undefined, 'imessage_new_chat_unavailable'),
    );
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'keep this draft');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toContain('Couldn’t start');
    expect(useDialogStore.getState().current?.message).not.toContain(
      'whether the iMessage was sent',
    );
    expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();
  });

  it.each([
    ['untyped HTTP 400', ApiError.fromStatus(400, 'bad request')],
    [
      'reused idempotency key',
      ApiError.fromStatus(409, 'key already used', undefined, 'idempotency_key_reused'),
    ],
  ])('keeps the uncertain-send warning for %s', async (_name, failure) => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    mockCreateNewChat.mockRejectedValueOnce(failure);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551230000');
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'keep this draft');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('New message'));
    expect(useDialogStore.getState().current?.message).toContain(
      'could not confirm whether the iMessage was sent',
    );
  });

  it('keeps SHARE-created new iMessage conversations blocked while preserving existing-chat routing', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        rcs: true,
        ...RCS_SERVER_IDENTITY,
        supports_imessage_new_chat: true,
      }),
    });
    stageShare(PRIVATE_SHARE_BATCH, 'hello', []);
    await renderWithTheme(<NewChatScreen />);
    await act(async () => {
      fireEvent.press(screen.getByRole('radio', { name: 'iMessage' }));
    });
    await addRecipient('+15551234567');
    expect(
      screen.getByText(/Starting a new iMessage conversation from Share is disabled/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
    expect(mockCreateNewChat).not.toHaveBeenCalled();
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

    // The attachment tray renders the staged file (its remove affordance is the stable handle).
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message')).toBeTruthy();

    // The create endpoint requires initial text, so a staged file alone cannot start a thread.
    await addRecipient('+15551234567');
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    expect(mockCreateNewChat).not.toHaveBeenCalled();
    expect(mockSendImages).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'Forwarded attachment');
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState).toEqual({
        disabled: false,
      }),
    );
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });
    await waitFor(() =>
      expect(mockSendImages).toHaveBeenCalledWith(
        {
          chatGuid: 'RCS;-;+15551234567',
          images: [{ uri, name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', size: 1234 }],
        },
        expect.objectContaining({ isCurrent: expect.any(Function) }),
        presentSendIssue,
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
  it('keeps recipient, service, and message controls inert until receipt reconciliation finishes', async () => {
    const receiptRead = deferred<null>();
    mockGetShareIntakeReceipt.mockReturnValue(receiptRead.promise);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        rcs: true,
        ...RCS_SERVER_IDENTITY,
        supports_rcs_send_attempt_ownership: true,
        supports_imessage_new_chat: true,
      }),
    });
    stageShare(PRIVATE_SHARE_BATCH);

    await renderWithTheme(<NewChatScreen />);

    expect(screen.getByText(/Checking the shared item/)).toBeTruthy();
    expect(screen.getByPlaceholderText('Phone or email').props.editable).toBe(false);
    expect(screen.getByPlaceholderText('Message').props.editable).toBe(false);
    expect(screen.getByRole('radio', { name: 'RCS' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();

    await act(async () => {
      receiptRead.resolve(null);
      await receiptRead.promise;
    });

    await waitFor(() => expect(screen.queryByText(/Checking the shared item/)).toBeNull());
    expect(screen.getByPlaceholderText('Phone or email').props.editable).toBe(true);
    expect(screen.getByPlaceholderText('Message').props.editable).toBe(true);
  });

  it('freezes the exact shared RCS draft while its durable send plan is being saved', async () => {
    const planPreparation = deferred<unknown>();
    mockPrepareSharePlan.mockReturnValue(planPreparation.promise);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        rcs: true,
        supports_imessage_new_chat: true,
        supports_rcs_send_attempt_ownership: true,
        ...RCS_SERVER_IDENTITY,
      }),
    });
    stageShare(PRIVATE_SHARE_BATCH, PRIVATE_MESSAGE, []);

    await renderWithTheme(<NewChatScreen />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Phone or email').props.editable).toBe(true),
    );
    await addRecipient(PRIVATE_ADDRESS);

    const toInput = screen.getByPlaceholderText('Add another…');
    const messageInput = screen.getByPlaceholderText('Message');
    const staleToChange = toInput.props.onChangeText as (text: string) => void;
    const staleMessageChange = messageInput.props.onChangeText as (text: string) => void;
    const staleRemoveRecipient = retainConfiguredPress(
      screen.getByLabelText(`Remove ${PRIVATE_ADDRESS}`),
    );
    const staleSelectIMessage = retainConfiguredPress(
      screen.getByRole('radio', { name: 'iMessage' }),
    );
    const staleStart = retainConfiguredPress(screen.getByRole('button', { name: 'Start' }));
    const staleDiscard = mockUnsavedChangesOptions?.onDiscard;
    expect(typeof staleDiscard).toBe('function');

    fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mockPrepareSharePlan).toHaveBeenCalledTimes(1));

    expect(screen.getByPlaceholderText('Add another…').props.editable).toBe(false);
    expect(screen.getByPlaceholderText('Message').props.editable).toBe(false);
    expect(screen.getByRole('radio', { name: 'RCS' }).props.accessibilityState.disabled).toBe(true);

    let discardResult: void | boolean | undefined;
    await act(async () => {
      staleToChange(SECOND_ADDRESS);
      staleMessageChange(SECOND_MESSAGE);
      staleRemoveRecipient();
      staleSelectIMessage();
      staleStart();
      discardResult = await staleDiscard?.();
      await Promise.resolve();
    });

    expect(screen.getByLabelText(`Remove ${PRIVATE_ADDRESS}`)).toBeTruthy();
    expect(screen.getByPlaceholderText('Add another…').props.value).toBe('');
    expect(screen.getByPlaceholderText('Message').props.value).toBe(PRIVATE_MESSAGE);
    expect(screen.getByRole('radio', { name: 'RCS' }).props.accessibilityState.selected).toBe(true);
    expect(mockPrepareSharePlan).toHaveBeenCalledTimes(1);
    expect(discardResult).toBe(false);
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();

    const preparedPlan = mockPrepareSharePlan.mock.calls[0]?.[1];
    await act(async () => {
      planPreparation.resolve(preparedPlan);
      await planPreparation.promise;
    });

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [PRIVATE_ADDRESS],
        PRIVATE_MESSAGE,
        expect.anything(),
        'RCS',
        `share-${PRIVATE_SHARE_BATCH}`,
        expect.objectContaining({
          plan: expect.objectContaining({
            address: PRIVATE_ADDRESS,
            body: PRIVATE_MESSAGE,
            service: 'RCS',
          }),
        }),
      ),
    );
  });

  it('captures only the route-named batch and does not clear durable ownership on mount', async () => {
    const sharedFile = {
      uri: 'file:///cache/shared-in/report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 42,
      origin: 'share' as const,
      shareItemIndex: 0,
    };
    stageShare(PRIVATE_SHARE_BATCH, 'Shared note', [sharedFile]);

    await renderWithTheme(<NewChatScreen />);

    expect(screen.getByPlaceholderText('Message').props.value).toBe('Shared note');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: PRIVATE_SHARE_BATCH,
      text: 'Shared note',
      files: [sharedFile],
    });
    expect(mockConsumeShareIntakeBatchIfComplete).not.toHaveBeenCalled();
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();
  });

  it('blocks a SHARE new-chat retry after the server replay window safety margin', async () => {
    stageShare(PRIVATE_SHARE_BATCH, 'Old shared note', []);
    useShareIntentStore.setState({
      createdAtMs: Date.now() - SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS,
    });

    await renderWithTheme(<NewChatScreen />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Phone or email').props.editable).toBe(true),
    );
    await addRecipient(PRIVATE_ADDRESS);

    expect(screen.getByText(/too old to retry safely/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('ignores an ambient batch when the route does not carry that exact id', async () => {
    useShareIntentStore.setState({
      batchId: PRIVATE_SHARE_BATCH,
      text: 'Must stay ambient',
      files: [sharedPrivateImage()],
      targetToken: null,
    });
    mockSearchParams = { shareBatch: SECOND_SHARE_BATCH };

    await renderWithTheme(<NewChatScreen />);

    expect(screen.getByPlaceholderText('Message').props.value).toBe('');
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
    expect(useShareIntentStore.getState().batchId).toBe(PRIVATE_SHARE_BATCH);
  });

  it('discards only its captured batch when the user explicitly abandons the draft', async () => {
    stageShare(PRIVATE_SHARE_BATCH);
    await renderWithTheme(<NewChatScreen />);

    expect(mockUnsavedChangesOptions?.enabled).toBe(true);
    await mockUnsavedChangesOptions?.onDiscard?.();

    expect(mockDiscardShareIntakeBatch).toHaveBeenCalledTimes(1);
    expect(mockDiscardShareIntakeBatch).toHaveBeenCalledWith(
      PRIVATE_SHARE_BATCH,
      expect.objectContaining({
        drainNext: false,
        lease: expect.objectContaining({ isCurrent: expect.any(Function) }),
      }),
    );
    expect(mockConsumeShareIntakeBatchIfComplete).not.toHaveBeenCalled();
    expect(mockDrainShareIntake).not.toHaveBeenCalled();

    mockUnsavedChangesOptions?.onAfterDiscardNavigation?.();
    expect(mockDrainShareIntake).toHaveBeenCalledTimes(1);
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
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
      ),
    );
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent('RCS;-;+15551234567')}`),
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
    stageShare(PRIVATE_SHARE_BATCH);
    mockSearchContacts.mockResolvedValue([{ name: PRIVATE_NAME, address: PRIVATE_ADDRESS }]);
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

    expect(mockFindChat).not.toHaveBeenCalled();
    expect(screen.queryByText(/Open it/)).toBeNull();

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), PRIVATE_MESSAGE);
    });
    await fireEvent.press(screen.getByText('Start'));

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [PRIVATE_ADDRESS],
        PRIVATE_MESSAGE,
        expect.anything(),
        'RCS',
        `share-${PRIVATE_SHARE_BATCH}`,
        expect.objectContaining({
          identity: expect.objectContaining({ batchId: PRIVATE_SHARE_BATCH, fileCount: 1 }),
          plan: expect.objectContaining({
            address: PRIVATE_ADDRESS,
            body: PRIVATE_MESSAGE,
            providerEpoch: RCS_PROVIDER_EPOCH,
          }),
        }),
      ),
    );
    const accountLease = mockCreateNewChat.mock.calls[0]?.[2];
    await waitFor(() =>
      expect(mockSendImages).toHaveBeenCalledWith(
        {
          chatGuid: PRIVATE_CREATED_GUID,
          images: [sharedPrivateImage()],
          shareIntake: expect.objectContaining({ batchId: PRIVATE_SHARE_BATCH, fileCount: 1 }),
        },
        accountLease,
        presentSendIssue,
        expect.any(Function),
      ),
    );
    await waitFor(() =>
      expect(mockConsumeShareIntakeBatchIfComplete).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: PRIVATE_SHARE_BATCH, fileCount: 1 }),
        expect.objectContaining({
          drainNext: false,
          lease: expect.objectContaining({ isCurrent: expect.any(Function) }),
        }),
      ),
    );
    expect(mockSendImages.mock.invocationCallOrder[0]!).toBeLessThan(
      mockConsumeShareIntakeBatchIfComplete.mock.invocationCallOrder[0]!,
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(PRIVATE_CREATED_GUID)}`);
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_URI);
  });
});

describe('NewChatScreen — standard recipient addresses', () => {
  const useIMessageOnly = (): void => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
  };

  it('starts an iMessage to a ten-digit number typed without a country code, as +1', async () => {
    useIMessageOnly();
    mockCreateNewChat.mockResolvedValue('any;-;+15551234567');
    await renderWithTheme(<NewChatScreen />);

    await addRecipient('(555) 123-4567');
    // The chip shows the number Start will use, so the assumed +1 is visible.
    expect(await screen.findByText('+15551234567 ✕')).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hello');
    });
    expect(screen.queryByText(/number with country code/)).toBeNull();
    await waitFor(() =>
      expect(mockFindChat).toHaveBeenLastCalledWith(undefined, ['+15551234567'], 'iMessage'),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    });

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        ['+15551234567'],
        'hello',
        expect.anything(),
        'iMessage',
        'temp-00000000-0000-4000-8000-000000000001',
      ),
    );
  });

  it('standardizes a picked contact number and never adds the same person twice', async () => {
    useIMessageOnly();
    mockSearchContacts.mockResolvedValue([{ name: 'Alice', address: '(555) 000-0001' }]);
    await renderWithTheme(<NewChatScreen />);

    await act(async () => {
      fireEvent.press(await screen.findByText('Alice'));
    });
    expect(await screen.findByText('Alice ✕')).toBeTruthy();
    await waitFor(() =>
      expect(mockFindChat).toHaveBeenLastCalledWith(undefined, ['+15550000001'], 'iMessage'),
    );
    // Picked, the contact leaves the suggestions; typed again in another format, it isn't added.
    expect(screen.queryByText('Alice')).toBeNull();
    await addRecipient('+1 555 000 0001');
    expect(screen.getAllByText(/✕$/)).toHaveLength(1);
  });

  it.each([
    ['555-123-4567', '+15551234567'],
    ['Pat@Example.com', 'pat@example.com'],
    // Not provably standard, so it is sent exactly as typed and Google reads it.
    ['07700 900123', '07700 900123'],
  ])('sends the RCS start for %j to %j', async (typed, expected) => {
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    await addRecipient(typed);
    await act(async () => {
      fireEvent.press(screen.getByText('Start'));
    });

    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [expected],
        'Hi',
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
      ),
    );
  });

  it('still refuses an iMessage start to a number it cannot standardize', async () => {
    useIMessageOnly();
    mockSearchParams = { forwardText: 'Hi' };
    await renderWithTheme(<NewChatScreen />);

    await addRecipient('07700 900123');

    expect(await screen.findByText(/number with country code/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled).toBe(
      true,
    );
  });
});

describe('NewChatScreen — account ownership and handoff lifetime', () => {
  it('does not consume external state for an initially stale account, then a fresh mount adopts it', async () => {
    const release = jest.fn();
    const clearShareIntent = jest.fn(() => useShareIntentStore.setState({ text: null, files: [] }));
    stageProtectedForward(release);
    stageShare(PRIVATE_SHARE_BATCH);
    useShareIntentStore.setState({ clear: clearShareIntent });
    await pauseRealtimeDeliveries();

    const staleView = await renderWithTheme(<NewChatScreen />);
    expectAccountChangedComposer(staleView.toJSON());
    expect(keyboardDismissSpy).toHaveBeenCalled();
    expect(clearShareIntent).not.toHaveBeenCalled();
    expect(mockFileInfoReads).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(mockSearchContacts).toHaveBeenCalledTimes(1);
    expect(mockSearchContacts).toHaveBeenCalledWith(undefined, '', 30);
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
    expect(clearShareIntent).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: PRIVATE_SHARE_BATCH,
      text: PRIVATE_MESSAGE,
      files: [sharedPrivateImage()],
    });
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
    stageShare(PRIVATE_SHARE_BATCH);
    mockSearchContacts.mockResolvedValue([
      { name: PRIVATE_NAME, address: PRIVATE_ADDRESS },
      { name: SECOND_NAME, address: SECOND_ADDRESS },
    ]);
    mockCreateNewChat.mockResolvedValue(SECOND_CREATED_GUID);
    const oldView = await renderWithTheme(<NewChatScreen />);

    await fireEvent.changeText(screen.getByPlaceholderText('Phone or email'), PRIVATE_QUERY);
    await fireEvent.press(await screen.findByText(PRIVATE_NAME));
    await fireEvent.changeText(screen.getByPlaceholderText('Add another…'), SECOND_ADDRESS);
    const oldToInput = screen.getByPlaceholderText('Add another…');
    const oldToChange = oldToInput.props.onChangeText as (text: string) => void;
    const oldToSubmit = oldToInput.props.onSubmitEditing as () => void;
    const oldMessageChange = screen.getByPlaceholderText('Message').props.onChangeText as (
      text: string,
    ) => void;
    const oldChip = retainConfiguredPress(screen.getByLabelText(`Remove ${PRIVATE_NAME}`));
    const oldAttachment = retainConfiguredPress(screen.getByLabelText('Remove attachment'));
    const oldSuggestion = retainConfiguredPress(await screen.findByText(SECOND_NAME));
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
      oldSuggestion();
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
    expect(mockFindChat).not.toHaveBeenCalled();
    expect(screen.queryByText(/Open it/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(mockCreateNewChat).toHaveBeenCalledWith(
        [SECOND_ADDRESS],
        SECOND_MESSAGE,
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
      ),
    );
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent(SECOND_CREATED_GUID)}`);
    expect(currentView.toJSON()).not.toBeNull();
  });

  it.each(['success', 'rejection'] as const)(
    'keeps fresh B existing-chat routing when retired A lookup settles with %s',
    async (outcome) => {
      useSessionStore.setState({
        serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
      });
      const oldLookup = deferred<ExistingChatMatch[]>();
      const freshLookup = deferred<ExistingChatMatch[]>();
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
        freshLookup.resolve([existing(PRIVATE_EXISTING_GUID)]);
        await freshLookup.promise;
      });
      expect(await screen.findByText(/Open it/)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldLookup.resolve([existing('iMessage;-;retired-A-match-39e4')]);
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
      const oldLease = mockCreateNewChat.mock.calls[0]?.[2];

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
      stageShare(SECOND_SHARE_BATCH, SECOND_MESSAGE);
      const currentView = await renderWithTheme(<NewChatScreen />);
      await addRecipient(SECOND_ADDRESS);
      await fireEvent.press(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(mockSendImages).toHaveBeenCalledTimes(2));
      const currentLease = mockCreateNewChat.mock.calls[1]?.[2];
      expect(currentLease).not.toBe(oldLease);
      expect(mockSendImages).toHaveBeenLastCalledWith(
        {
          chatGuid: SECOND_CREATED_GUID,
          images: [sharedPrivateImage()],
          shareIntake: expect.objectContaining({ batchId: SECOND_SHARE_BATCH, fileCount: 1 }),
        },
        currentLease,
        presentSendIssue,
        expect.any(Function),
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
    expect(useDialogStore.getState().current?.message).toBe(UNCONFIRMED_RCS_COPY);
    expect(errorSpy).toHaveBeenCalledWith(
      '[new-chat] createNewChat failed',
      'sfcbzc1wod',
      expect.any(Error),
    );
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
  beforeEach(() => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
  });

  it('offers to open an existing chat with the same recipients', async () => {
    mockFindChat.mockResolvedValue([existing('iMessage;-;existing')]);
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

  it('lists every chat with these people, newest selected, and opens the one picked', async () => {
    const now = Date.now();
    mockFindChat.mockResolvedValue([
      existing('any;+;chat-new', { name: 'Weekend', latestMessageDate: now, isGroup: true }),
      existing('iMessage;+;chat-old', { latestMessageDate: now - 60_000, isGroup: true }),
    ]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15551112222');
    await addRecipient('+15553334444');

    const newest = await screen.findByRole('radio', { name: /^Weekend · / });
    const older = screen.getByRole('radio', { name: /^Group conversation · / });
    expect(newest.props.accessibilityState.selected).toBe(true);
    expect(older.props.accessibilityState.selected).toBe(false);

    await fireEvent.press(older);
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: /^Group conversation · / }).props.accessibilityState
          .selected,
      ).toBe(true),
    );
    expect(
      screen.getByRole('radio', { name: /^Weekend · / }).props.accessibilityState.selected,
    ).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: /Open it/ }));
    expect(mockReplace).toHaveBeenCalledWith(`/chat/${encodeURIComponent('iMessage;+;chat-old')}`);
  });

  it('shows only the Open it banner when there is one match', async () => {
    mockFindChat.mockResolvedValue([existing('any;-;+15559999999', { latestMessageDate: 1 })]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient('+15559999999');

    expect(await screen.findByRole('button', { name: /Open it/ })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('transfers the exact share claim to an existing conversation without consuming it', async () => {
    const existingGuid = 'iMessage;-;existing-share-target';
    stageShare(PRIVATE_SHARE_BATCH);
    mockFindChat.mockResolvedValue([existing(existingGuid)]);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await fireEvent.press(await screen.findByText(/Open it/));

    expect(mockReplace).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent(existingGuid)}?shareBatch=${encodeURIComponent(PRIVATE_SHARE_BATCH)}`,
    );
    expect(mockConsumeShareIntakeBatchIfComplete).not.toHaveBeenCalled();
    expect(mockDiscardShareIntakeBatch).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().batchId).toBe(PRIVATE_SHARE_BATCH);
  });

  it('hides a resolved A banner immediately while a new recipient-key lookup is pending', async () => {
    const pendingB = deferred<ExistingChatMatch[]>();
    mockFindChat
      .mockResolvedValueOnce([existing('iMessage;-;existing-A')])
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
      pendingB.resolve([]);
      await pendingB.promise;
    });
    await waitFor(() => expect(screen.queryByText(/Open it/)).toBeNull());
  });

  it.each(['success', 'rejection'] as const)(
    'keeps a fresh same-key match when a cleaned-up lookup settles with %s',
    async (outcome) => {
      const oldLookup = deferred<ExistingChatMatch[]>();
      const freshLookup = deferred<ExistingChatMatch[]>();
      mockFindChat.mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(freshLookup.promise);
      await renderWithTheme(<NewChatScreen />);
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(1));

      await fireEvent.press(screen.getByLabelText(`Remove ${PRIVATE_ADDRESS}`));
      await waitFor(() => expect(screen.queryByText(`${PRIVATE_ADDRESS} ✕`)).toBeNull());
      await addRecipient(PRIVATE_ADDRESS);
      await waitFor(() => expect(mockFindChat).toHaveBeenCalledTimes(2));
      await act(async () => {
        freshLookup.resolve([existing(PRIVATE_EXISTING_GUID)]);
        await freshLookup.promise;
      });
      expect(await screen.findByText(/Open it/)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success')
          oldLookup.resolve([existing('iMessage;-;stale-same-key-match-a714')]);
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
    expect(useDialogStore.getState().current?.message).toBe(UNCONFIRMED_RCS_COPY);
    expect(error).toHaveBeenCalledWith(
      '[new-chat] createNewChat failed',
      'sfcbzc1wod',
      expect.any(Error),
    );
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
      const accountLease = mockCreateNewChat.mock.calls[0]?.[2] as { isCurrent: () => boolean };
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
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
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
        expect.anything(),
        'RCS',
        STABLE_RCS_ATTEMPT_ID,
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

describe('NewChatScreen — RCS file size limit', () => {
  const OVER_LIMIT = MAX_RCS_ATTACHMENT_UPLOAD_BYTES + 1;
  const TOO_LARGE_NOTE = `“${PRIVATE_FILENAME}” is larger than RCS allows (100 MiB). Remove it from your message to start.`;

  async function renderRcsShareWith(size: number): Promise<void> {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: 'test',
        rcs: true,
        supports_imessage_new_chat: true,
        supports_rcs_send_attempt_ownership: true,
        ...RCS_SERVER_IDENTITY,
      }),
    });
    stageShare(PRIVATE_SHARE_BATCH, PRIVATE_MESSAGE, [{ ...sharedPrivateImage(), size }]);
    await renderWithTheme(<NewChatScreen />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Phone or email').props.editable).toBe(true),
    );
    await addRecipient(PRIVATE_ADDRESS);
  }

  function startDisabled(): boolean {
    return screen.getByRole('button', { name: 'Start' }).props.accessibilityState.disabled;
  }

  it('refuses to start an RCS chat with a file over the limit, and names the file', async () => {
    await renderRcsShareWith(OVER_LIMIT);

    expect(screen.getByRole('radio', { name: 'RCS' }).props.accessibilityState.selected).toBe(true);
    expect(startDisabled()).toBe(true);
    expect(screen.getByText(TOO_LARGE_NOTE)).toBeTruthy();
  });

  it('starts an RCS chat with a file of exactly the limit', async () => {
    await renderRcsShareWith(MAX_RCS_ATTACHMENT_UPLOAD_BYTES);

    expect(startDisabled()).toBe(false);
    expect(screen.queryByText(/larger than RCS allows/)).toBeNull();
  });

  it('allows Start again once the oversized file is removed', async () => {
    await renderRcsShareWith(OVER_LIMIT);
    expect(startDisabled()).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Remove attachment'));
    });

    await waitFor(() => expect(startDisabled()).toBe(false));
    expect(screen.queryByText(/larger than RCS allows/)).toBeNull();
  });

  it('leaves iMessage as before: a staged file keeps Start off with the iMessage note', async () => {
    await renderRcsShareWith(OVER_LIMIT);

    await act(async () => {
      fireEvent.press(screen.getByRole('radio', { name: 'iMessage' }));
    });

    expect(startDisabled()).toBe(true);
    expect(
      screen.getByText(
        'iMessage attachments are not available yet. Remove them or choose RCS to start.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/larger than RCS allows/)).toBeNull();
  });
});

describe('NewChatScreen — iMessage availability', () => {
  const imessageWithAvailability = ServerInfo.parse({
    version: 'test',
    supports_imessage_new_chat: true,
    supports_imessage_availability: true,
  });
  beforeEach(() => {
    mockCheckAvailability.mockReset();
  });

  it.each([
    [true, 'on iMessage'],
    [false, 'not on iMessage'],
  ])('labels a recipient after the lookup says available=%s', async (available, label) => {
    useSessionStore.setState({ serverInfo: imessageWithAvailability });
    mockCheckAvailability.mockResolvedValue(available);
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    expect(
      await screen.findByRole('button', { name: new RegExp(`\\(${label}\\)$`) }),
    ).toBeOnTheScreen();
    expect(mockCheckAvailability).toHaveBeenCalledTimes(1);
    expect(mockCheckAvailability.mock.calls[0]?.[1]).toBe(PRIVATE_ADDRESS);
    if (available) {
      expect(screen.queryByText(/isn’t on iMessage/)).toBeNull();
    } else {
      expect(screen.getByText(/A green recipient isn’t on iMessage/)).toBeOnTheScreen();
    }
  });

  it('leaves the chip neutral when the lookup fails', async () => {
    useSessionStore.setState({ serverInfo: imessageWithAvailability });
    mockCheckAvailability.mockRejectedValue(new Error('helper down'));
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /on iMessage\)$/ })).toBeNull();
    expect(screen.queryByText(/isn’t on iMessage/)).toBeNull();
  });

  it('never looks up a recipient when the server lacks the lookup', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_new_chat: true }),
    });
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await screen.findByRole('button', { name: /^Remove / });
    expect(mockCheckAvailability).not.toHaveBeenCalled();
  });

  it('never looks up a recipient for an RCS message', async () => {
    await renderWithTheme(<NewChatScreen />);
    await addRecipient(PRIVATE_ADDRESS);

    await screen.findByRole('button', { name: /^Remove / });
    expect(mockCheckAvailability).not.toHaveBeenCalled();
  });
});
