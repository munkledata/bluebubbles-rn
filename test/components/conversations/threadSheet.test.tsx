/**
 * ThreadSheet (src/ui/conversations/ThreadSheet.tsx): the controlled "View Thread" sheet.
 * Besides its ordinary reply-count and jump behavior, this suite proves that thread rows never
 * cross account, originator, or controlled-open ownership boundaries while an async DB read settles.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { MessageRow } from '@db/repositories';
import { formatTime } from '@utils';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockListThreadMessages = jest.fn();
jest.mock('@db/repositories', () => ({
  listThreadMessages: (...args: unknown[]) => mockListThreadMessages(...args),
}));

interface CapturedLease {
  generation: number;
  isCurrent(): boolean;
}

let mockCapturedLease: CapturedLease | null = null;
const mockCaptureRealtimeDeliveryLease = jest.fn();
const mockRunTrackedRealtimeWork = jest.fn();

jest.mock('@/services/realtime/deliveryCoordinator', () => {
  const mockActualCoordinator = jest.requireActual('@/services/realtime/deliveryCoordinator');
  return {
    ...mockActualCoordinator,
    captureRealtimeDeliveryLease: () => {
      const lease = mockActualCoordinator.captureRealtimeDeliveryLease();
      mockCapturedLease = lease;
      mockCaptureRealtimeDeliveryLease(lease);
      return lease;
    },
    runTrackedRealtimeWork: (...args: unknown[]) => mockRunTrackedRealtimeWork(...args),
  };
});

// eslint-disable-next-line import/first
import { ThreadSheet } from '@ui/conversations/ThreadSheet';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const ORIGIN_A = 'private-thread-origin-a-z-8d31';
const ORIGIN_A_TEXT = 'private original body A z-51f0';
const REPLY_A_GUID = 'private-thread-reply-a-z-7c42';
const REPLY_A_SENDER = 'private-thread-sender-a-z-93b7@example.test';
const REPLY_A_TEXT = 'private reply body A z-e06c';
const REPLY_A_TIME = Date.UTC(2037, 4, 6, 7, 19);
const ATTACHMENT_A_GUID = 'private-thread-attachment-row-a-z-6a25';
const ATTACHMENT_A_SENDER = 'private-thread-attachment-sender-a-z-b814@example.test';
const ATTACHMENT_A_DESCRIPTION = 'Private Genmoji description A z-c903';
const ATTACHMENT_A_TIME = Date.UTC(2037, 4, 6, 8, 31);

const ORIGIN_B = 'replacement-thread-origin-b-z-d712';
const ORIGIN_B_TEXT = 'replacement original body B z-a950';
const REPLY_B_GUID = 'replacement-thread-reply-b-z-180e';
const REPLY_B_SENDER = 'replacement-thread-sender-b-z-45cf@example.test';
const REPLY_B_TEXT = 'replacement reply body B z-f263';
const REPLY_B_TIME = Date.UTC(2038, 7, 9, 10, 43);
const HIDDEN = { includeHiddenElements: true } as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function row(overrides: Partial<MessageRow> & { guid: string }): MessageRow {
  return {
    id: 1,
    chatId: 1,
    handleId: null,
    text: 'hello',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1_700_000_000_000,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    attachmentDescription: null,
    ...overrides,
  };
}

const THREAD_A: MessageRow[] = [
  row({ guid: ORIGIN_A, isFromMe: 1, text: ORIGIN_A_TEXT, dateCreated: REPLY_A_TIME - 60_000 }),
  row({
    id: 2,
    guid: REPLY_A_GUID,
    senderName: REPLY_A_SENDER,
    text: REPLY_A_TEXT,
    dateCreated: REPLY_A_TIME,
  }),
  row({
    id: 3,
    guid: ATTACHMENT_A_GUID,
    senderName: ATTACHMENT_A_SENDER,
    text: null,
    hasAttachments: 1,
    attachmentDescription: ATTACHMENT_A_DESCRIPTION,
    dateCreated: ATTACHMENT_A_TIME,
  }),
];

const THREAD_B: MessageRow[] = [
  row({ guid: ORIGIN_B, isFromMe: 1, text: ORIGIN_B_TEXT, dateCreated: REPLY_B_TIME - 60_000 }),
  row({
    id: 5,
    guid: REPLY_B_GUID,
    senderName: REPLY_B_SENDER,
    text: REPLY_B_TEXT,
    dateCreated: REPLY_B_TIME,
  }),
];

const PRIVATE_A_CANARIES = [
  ORIGIN_A_TEXT,
  REPLY_A_SENDER,
  REPLY_A_TEXT,
  ATTACHMENT_A_SENDER,
  ATTACHMENT_A_DESCRIPTION,
  formatTime(REPLY_A_TIME),
  formatTime(ATTACHMENT_A_TIME),
] as const;

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function expectCanariesAbsent(
  tree: unknown,
  canaries: readonly string[] = PRIVATE_A_CANARIES,
): void {
  const json = JSON.stringify(tree);
  for (const canary of canaries) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(regexFor(canary), HIDDEN)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

function configuredPress(node: {
  props: Record<string, unknown>;
}): ((event: object) => void) | undefined {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  return readConfig?.().onPress;
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): (event: object) => void {
  const press = configuredPress(node);
  if (!press) throw new Error('Expected the visible row to expose a configured press callback');
  return press;
}

async function invokeConfiguredPress(press: (event: object) => void): Promise<void> {
  await act(async () => {
    press({ nativeEvent: {} });
    await Promise.resolve();
  });
}

function resetCapturedAccount(): void {
  resumeRealtimeDeliveries();
  mockCapturedLease = null;
  mockCaptureRealtimeDeliveryLease.mockClear();
  mockRunTrackedRealtimeWork.mockReset().mockImplementation((...args: unknown[]) => {
    const actual = jest.requireActual('@/services/realtime/deliveryCoordinator') as {
      runTrackedRealtimeWork(...values: unknown[]): Promise<'delivered' | 'paused'>;
    };
    return actual.runTrackedRealtimeWork(...args);
  });
}

function StatefulThread({
  initialOriginatorGuid,
  onClose,
  onJump,
}: {
  initialOriginatorGuid: string | null;
  onClose: () => void;
  onJump: (message: { guid: string; dateCreated: number }) => void;
}): React.JSX.Element {
  const [originatorGuid, setOriginatorGuid] = React.useState(initialOriginatorGuid);
  const close = React.useCallback(() => {
    onClose();
    setOriginatorGuid(null);
  }, [onClose]);

  return (
    <>
      <ThreadSheet originatorGuid={originatorGuid} onClose={close} onJump={onJump} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open thread A"
        onPress={() => setOriginatorGuid(ORIGIN_A)}
      >
        <Text>Open thread A</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open thread B"
        onPress={() => setOriginatorGuid(ORIGIN_B)}
      >
        <Text>Open thread B</Text>
      </Pressable>
    </>
  );
}

describe('ThreadSheet', () => {
  beforeEach(() => {
    resetCapturedAccount();
    mockListThreadMessages
      .mockReset()
      .mockImplementation(async (_db, originatorGuid: string) =>
        originatorGuid === ORIGIN_B ? THREAD_B : THREAD_A,
      );
  });

  afterEach(() => {
    resetCapturedAccount();
  });

  it('loads a high-entropy thread through tracked account work and renders its exact host/a11y data', async () => {
    const view = await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={jest.fn()} onJump={jest.fn()} />,
    );

    expect(await screen.findByText('Thread · 2 replies')).toBeTruthy();
    expect(mockCaptureRealtimeDeliveryLease).toHaveBeenCalledTimes(1);
    expect(mockCapturedLease?.isCurrent()).toBe(true);
    expect(mockListThreadMessages).toHaveBeenCalledWith(undefined, ORIGIN_A);
    expect(screen.getByText('You · original')).toBeTruthy();
    expect(screen.getByText(ORIGIN_A_TEXT)).toBeTruthy();
    expect(screen.getByText(REPLY_A_SENDER)).toBeTruthy();
    expect(screen.getByText(REPLY_A_TEXT)).toBeTruthy();
    expect(screen.getByText(ATTACHMENT_A_SENDER)).toBeTruthy();
    expect(screen.getByText(ATTACHMENT_A_DESCRIPTION)).toBeTruthy();
    expect(screen.getByRole('text', { name: formatTime(REPLY_A_TIME) })).toBeTruthy();
    expect(screen.getByRole('text', { name: formatTime(ATTACHMENT_A_TIME) })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    ).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(REPLY_A_TEXT);
  });

  it('does not issue the DB read when tracked account admission returns paused', async () => {
    mockRunTrackedRealtimeWork.mockResolvedValueOnce('paused');
    const view = await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={jest.fn()} onJump={jest.fn()} />,
    );

    await waitFor(() => expect(mockRunTrackedRealtimeWork).toHaveBeenCalledTimes(1));
    expect(mockCapturedLease?.isCurrent()).toBe(true);
    expect(mockListThreadMessages).not.toHaveBeenCalled();
    expect(screen.getByText('Thread · 0 replies')).toBeTruthy();
    expectCanariesAbsent(view.toJSON());
  });

  it('keeps a current read rejection generic, empty, and dismissible', async () => {
    const read = deferred<MessageRow[]>();
    const rawError = 'thread-current-read-error-z-79ad';
    mockListThreadMessages.mockReturnValueOnce(read.promise);
    const onClose = jest.fn();
    const onJump = jest.fn();
    const view = await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    await waitFor(() => expect(mockListThreadMessages).toHaveBeenCalledTimes(1));

    await act(async () => {
      read.reject(new Error(rawError));
      await read.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(screen.getByText('Thread · 0 replies')).toBeTruthy();
    expectCanariesAbsent(view.toJSON(), [...PRIVATE_A_CANARIES, rawError]);
    await fireEvent.press(screen.getByTestId('thread-sheet-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-sheet-backdrop')).toBeNull();
  });

  it('uses the singular label for exactly one reply', async () => {
    mockListThreadMessages.mockResolvedValue(THREAD_A.slice(0, 2));
    await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={jest.fn()} onJump={jest.fn()} />,
    );
    expect(await screen.findByText('Thread · 1 reply')).toBeTruthy();
  });

  it('keeps the normal Unknown-sender and generic attachment fallbacks', async () => {
    mockListThreadMessages.mockResolvedValue([
      row({ guid: ORIGIN_A, isFromMe: 1, text: ORIGIN_A_TEXT }),
      row({
        guid: ATTACHMENT_A_GUID,
        senderName: null,
        text: null,
        hasAttachments: 1,
        attachmentDescription: null,
      }),
    ]);
    await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={jest.fn()} onJump={jest.fn()} />,
    );

    expect(await screen.findByText('Unknown')).toBeTruthy();
    expect(screen.getByText('📎 Attachment')).toBeTruthy();
    expect(screen.getByRole('button', { name: "Jump to Unknown's message" })).toBeTruthy();
  });

  it('closes and jumps to the exact tapped message', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    await fireEvent.press(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).toHaveBeenCalledWith({ guid: REPLY_A_GUID, dateCreated: REPLY_A_TIME });
  });

  it('closes without jumping when the row has no dateCreated', async () => {
    mockListThreadMessages.mockResolvedValue([
      row({ guid: ORIGIN_A, isFromMe: 1 }),
      row({ guid: REPLY_A_GUID, senderName: REPLY_A_SENDER, dateCreated: null }),
    ]);
    const onClose = jest.fn();
    const onJump = jest.fn();
    await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    await fireEvent.press(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('renders nothing, never queries, and never closes when originatorGuid is null', async () => {
    const onClose = jest.fn();
    await renderWithTheme(
      <ThreadSheet originatorGuid={null} onClose={onClose} onJump={jest.fn()} />,
    );
    await waitFor(() => expect(screen.queryByText(/Thread ·/, HIDDEN)).toBeNull());
    expect(mockListThreadMessages).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fails closed when mounted while account admission is paused', async () => {
    await pauseRealtimeDeliveries();
    const onClose = jest.fn();
    const view = await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={jest.fn()} />,
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockCapturedLease?.isCurrent()).toBe(false);
    expect(mockListThreadMessages).not.toHaveBeenCalled();
    expectCanariesAbsent(view.toJSON());
    resumeRealtimeDeliveries();
  });

  it('removes resolved account-A rows synchronously and revokes their retained callback on retirement', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    const view = await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    const oldPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    expect(mockCapturedLease?.isCurrent()).toBe(true);

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    expect(mockCapturedLease?.isCurrent()).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expectCanariesAbsent(view.toJSON());
    await invokeConfiguredPress(oldPress);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
    resumeRealtimeDeliveries();
  });

  it('uses the captured account lease to revoke an unmounted row callback while a fresh account works', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    const view = await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    const oldPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    const oldLease = mockCapturedLease;
    expect(oldLease?.isCurrent()).toBe(true);

    await act(async () => {
      view.unmount();
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    expect(oldLease?.isCurrent()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await invokeConfiguredPress(oldPress);
    expect(onClose).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();

    resumeRealtimeDeliveries();
    await renderWithTheme(
      <ThreadSheet originatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    const freshPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    await invokeConfiguredPress(freshPress);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith({ guid: REPLY_A_GUID, dateCreated: REPLY_A_TIME });
  });

  it.each(['success', 'rejection'] as const)(
    'drops a deferred %s after the original account is retired',
    async (outcome) => {
      const read = deferred<MessageRow[]>();
      const rawError = 'private-thread-account-read-error-z-14ec';
      mockListThreadMessages.mockReturnValue(read.promise);
      const onClose = jest.fn();
      const view = await renderWithTheme(
        <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={jest.fn()} />,
      );
      await waitFor(() => expect(mockListThreadMessages).toHaveBeenCalledTimes(1));

      let pauseSettled = false;
      let pause!: Promise<void>;
      await act(async () => {
        pause = pauseRealtimeDeliveries().then(() => {
          pauseSettled = true;
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(mockCapturedLease?.isCurrent()).toBe(false);
      expect(pauseSettled).toBe(false);
      await act(async () => {
        if (outcome === 'success') read.resolve(THREAD_A);
        else read.reject(new Error(rawError));
        await read.promise.catch(() => undefined);
        await pause;
      });
      resumeRealtimeDeliveries();

      expectCanariesAbsent(view.toJSON(), [...PRIVATE_A_CANARIES, rawError]);
    },
  );

  it.each(['success', 'rejection'] as const)(
    'does not let a deferred originator-A %s replace the loaded originator-B rows',
    async (outcome) => {
      const oldRead = deferred<MessageRow[]>();
      const rawError = 'private-thread-originator-read-error-z-5b38';
      mockListThreadMessages.mockImplementation(async (_db, originatorGuid: string) => {
        if (originatorGuid === ORIGIN_A) return oldRead.promise;
        return THREAD_B;
      });
      const onClose = jest.fn();
      const onJump = jest.fn();
      const view = await renderWithTheme(
        <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
      );
      await waitFor(() => expect(mockListThreadMessages).toHaveBeenCalledWith(undefined, ORIGIN_A));

      await fireEvent.press(screen.getByRole('button', { name: 'Open thread B' }));
      expect(await screen.findByText(REPLY_B_TEXT)).toBeTruthy();
      expect(screen.getByText(REPLY_B_SENDER)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldRead.resolve(THREAD_A);
        else oldRead.reject(new Error(rawError));
        await oldRead.promise.catch(() => undefined);
      });

      expect(screen.getByText(REPLY_B_TEXT)).toBeTruthy();
      expect(screen.getByRole('text', { name: formatTime(REPLY_B_TIME) })).toBeTruthy();
      expectCanariesAbsent(view.toJSON(), [...PRIVATE_A_CANARIES, rawError]);
      expect(onClose).not.toHaveBeenCalled();
      expect(onJump).not.toHaveBeenCalled();
    },
  );

  it('revokes an already-loaded A row callback when the controlled source changes to B', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    const oldPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Open thread B' }));
    expect(await screen.findByText(REPLY_B_TEXT)).toBeTruthy();
    await invokeConfiguredPress(oldPress);

    expect(onClose).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByText(REPLY_B_TEXT)).toBeTruthy();

    const freshPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Jump to ${REPLY_B_SENDER}'s message` }),
    );
    await invokeConfiguredPress(freshPress);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).toHaveBeenCalledWith({ guid: REPLY_B_GUID, dateCreated: REPLY_B_TIME });
  });

  it('revokes a retained row callback after close and same-originator reopen', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    const view = await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    const oldPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );

    await fireEvent.press(screen.getByTestId('thread-sheet-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expectCanariesAbsent(view.toJSON());

    // Reopen the SAME originator after the parent committed null. Originator and account are
    // identical, leaving the controlled opening's lifetime as the only fact that can revoke the old
    // native Pressability callback.
    await fireEvent.press(screen.getByRole('button', { name: 'Open thread A' }));
    expect(await screen.findByText(REPLY_A_TEXT)).toBeTruthy();
    await invokeConfiguredPress(oldPress);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByText(REPLY_A_TEXT)).toBeTruthy();

    const freshPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Jump to ${REPLY_A_SENDER}'s message` }),
    );
    await invokeConfiguredPress(freshPress);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith({ guid: REPLY_A_GUID, dateCreated: REPLY_A_TIME });
  });

  it('dismisses an ordinary visible thread through the real backdrop without jumping', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    const view = await renderWithTheme(
      <StatefulThread initialOriginatorGuid={ORIGIN_A} onClose={onClose} onJump={onJump} />,
    );
    expect(await screen.findByText(REPLY_A_TEXT)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('thread-sheet-backdrop'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-sheet-backdrop')).toBeNull();
    expectCanariesAbsent(view.toJSON());
  });
});
