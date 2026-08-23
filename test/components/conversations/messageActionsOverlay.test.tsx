/**
 * MessageActionsOverlay (src/ui/conversations/MessageActionsOverlay.tsx): the long-press
 * tapback + action sheet for a single message. This suite locks in the USER-OBSERVABLE
 * behavior derived from the source:
 *   - for a confirmed message, the reaction picker renders the 6 base types in PICKER_ORDER
 *     (accessibilityLabel from reactionMeta) and a tap fires onReact with the RIGHT wire type —
 *     the base ('love') when the user hasn't applied it, the removal ('-love') when they have
 *     (toggle) — then onClose;
 *   - Reply requires a confirmed server identity; Remind Me Later remains available locally;
 *   - Copy + Forward appear only when there's trimmed text (hasText);
 *   - Save to Photos appears only when the message has attachments;
 *   - Edit + Unsend appear only for the user's OWN recent, non-retracted, non-temp message
 *     (canEditUnsend); Edit additionally requires text;
 *   - Cancel Sending / Remove appears only for an own optimistic message that is 'sending' or
 *     'error' (canCancel), with the label switching on sendState.
 *
 * In-file mock: `react-native-safe-area-context` — the overlay calls useSafeAreaInsets, which
 * needs a provider; return zero insets (mirrors composer.test.tsx). The component takes clipboard
 * concerns as the `onCopy` PROP (the parent owns expo-clipboard), so there is no clipboard import
 * to stub here — Copy is asserted via the onCopy callback.
 *
 * The component renders inside a react-native Modal whose mount does async work; after every
 * fireEvent we flush with `await waitFor` so no deferred update bleeds into the next test's act
 * environment (an un-flushed press corrupts later renders — RNTL 14 / React 19 gotcha).
 */
import React from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import {
  MessageActionsOverlay,
  type SelectedMessage,
} from '@ui/conversations/MessageActionsOverlay';
import type { ReactionBaseType } from '@core/reactions/reactionType';

interface CompositeHandle {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListeners: Array<(enabled: boolean) => void>;
let removeReduceMotionListeners: jest.Mock[];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function spySprings(): {
  handles: CompositeHandle[];
  spy: jest.SpyInstance;
  restore: () => void;
} {
  const handles: CompositeHandle[] = [];
  const spy = jest.spyOn(Animated, 'spring').mockImplementation(() => {
    const handle: CompositeHandle = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    handles.push(handle);
    return handle as unknown as Animated.CompositeAnimation;
  });
  return { handles, spy, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  reduceMotionListeners = [];
  removeReduceMotionListeners = [];
  mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
  mockAddEventListener.mockReset().mockImplementation((event, listener) => {
    expect(event).toBe('reduceMotionChanged');
    reduceMotionListeners.push(listener as (enabled: boolean) => void);
    const remove = jest.fn();
    removeReduceMotionListeners.push(remove);
    return { remove };
  });
});

// Zero insets so useSafeAreaInsets() resolves without a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/** All callbacks as jest.fns so a test can assert exactly which fired. */
function handlers() {
  return {
    onClose: jest.fn(),
    onReact: jest.fn(),
    onReply: jest.fn(),
    onRemindLater: jest.fn(),
    onEdit: jest.fn(),
    onUnsend: jest.fn(),
    onCancelSend: jest.fn(),
    onCopy: jest.fn(),
    onForward: jest.fn(),
    onSave: jest.fn(),
    onShare: jest.fn(),
    onDelete: jest.fn(),
    onViewThread: jest.fn(),
    onViewEditHistory: jest.fn(),
    onSelect: jest.fn(),
  };
}

/** A received text message with no prior reactions (the plain baseline). */
function makeSelected(overrides: Partial<SelectedMessage> = {}): SelectedMessage {
  return {
    guid: 'm1',
    text: 'hey there',
    isFromMe: false,
    senderName: 'Alice',
    mine: [],
    dateCreated: Date.now(),
    isRetracted: false,
    isEdited: false,
    isTemp: false,
    sendState: 'sent',
    attachments: [],
    ...overrides,
  };
}

async function renderOverlay(
  selected: SelectedMessage,
  h: ReturnType<typeof handlers> = handlers(),
) {
  await renderWithTheme(<MessageActionsOverlay selected={selected} {...h} />);
  return h;
}

/** Press a labelled/text control and flush the resulting act work before the test ends. */
async function pressAndFlush(node: Parameters<typeof fireEvent.press>[0], after: () => void) {
  fireEvent.press(node);
  await waitFor(after);
}

describe('MessageActionsOverlay — reaction picker', () => {
  const CASES: [ReactionBaseType, string][] = [
    ['love', 'Heart'],
    ['like', 'Like'],
    ['dislike', 'Dislike'],
    ['laugh', 'Laugh'],
    ['emphasize', 'Emphasize'],
    ['question', 'Question'],
  ];

  it.each(CASES)('tapping %s fires onReact with the base type + onClose', async (base, label) => {
    const h = await renderOverlay(makeSelected());
    await pressAndFlush(screen.getByLabelText(label), () => {
      expect(h.onReact).toHaveBeenCalledWith(base);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('tapping a reaction the user already applied fires the REMOVAL type (toggle off)', async () => {
    // mine=['love'] → tapping Heart should send '-love', not 'love'.
    const h = await renderOverlay(makeSelected({ mine: ['love'] }));
    await pressAndFlush(screen.getByLabelText('Heart'), () =>
      expect(h.onReact).toHaveBeenCalledWith('-love'),
    );
  });

  it('marks an already-applied reaction as accessibilityState selected', async () => {
    await renderOverlay(makeSelected({ mine: ['like'] }));
    expect(screen.getByLabelText('Like').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByLabelText('Heart').props.accessibilityState).toEqual({ selected: false });
  });

  const TEMP_LAYOUTS: Array<[string, SelectedMessage['anchorRect']]> = [
    ['fallback', undefined],
    ['anchored', { x: 24, y: 180, width: 140, height: 44 }],
  ];

  it.each(TEMP_LAYOUTS)(
    'hides every server-target control for a temp message in the %s layout',
    async (_layout, anchorRect) => {
      await renderOverlay(
        makeSelected({
          isFromMe: true,
          isTemp: true,
          sendState: 'sending',
          text: 'still sending',
          myEmojis: ['🔥'],
          anchorRect,
        }),
      );

      for (const [, label] of CASES) expect(screen.queryByLabelText(label)).toBeNull();
      expect(screen.queryByLabelText('Remove 🔥 reaction')).toBeNull();
      expect(screen.queryByLabelText('React with any emoji')).toBeNull();
      expect(screen.queryByLabelText('Emoji reaction input')).toBeNull();
      expect(screen.queryByText('Reply')).toBeNull();

      // Local actions remain usable; the overlay itself was not hidden as a shortcut.
      expect(screen.getByText('Cancel Sending')).toBeTruthy();
      expect(screen.getByText('Copy')).toBeTruthy();
    },
  );

  it('drops an open anchored emoji input immediately when the same selection becomes temp', async () => {
    const h = handlers();
    const anchorRect = { x: 24, y: 180, width: 140, height: 44 };
    const view = await renderWithTheme(
      <MessageActionsOverlay selected={makeSelected({ guid: 'm-confirmed', anchorRect })} {...h} />,
    );

    fireEvent.press(screen.getByLabelText('React with any emoji'));
    const input = await screen.findByLabelText('Emoji reaction input');
    fireEvent.changeText(input, '🔥');
    await waitFor(() =>
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥'),
    );

    await view.rerender(
      <MessageActionsOverlay
        selected={makeSelected({
          guid: 'm-confirmed',
          isFromMe: true,
          isTemp: true,
          sendState: 'sending',
          anchorRect,
        })}
        {...h}
      />,
    );
    expect(screen.queryByLabelText('Emoji reaction input')).toBeNull();
    expect(screen.queryByLabelText('React with any emoji')).toBeNull();
    expect(screen.queryByLabelText('Heart')).toBeNull();
    expect(screen.queryByText('Reply')).toBeNull();
    expect(screen.getByText('Cancel Sending')).toBeTruthy();

    await view.rerender(
      <MessageActionsOverlay
        selected={makeSelected({ guid: 'm-fresh-confirmed', anchorRect })}
        {...h}
      />,
    );
    expect(screen.getByLabelText('Heart')).toBeTruthy();
    expect(screen.getByLabelText('React with any emoji')).toBeTruthy();
    expect(screen.getByText('Reply')).toBeTruthy();
    expect(screen.queryByLabelText('Emoji reaction input')).toBeNull();
  });
});

describe('MessageActionsOverlay — confirmed Reply + local actions', () => {
  it('Reply fires onReply + onClose', async () => {
    const h = await renderOverlay(makeSelected());
    await pressAndFlush(screen.getByText('Reply'), () => {
      expect(h.onReply).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('Remind Me Later fires onRemindLater + onClose', async () => {
    const h = await renderOverlay(makeSelected());
    await pressAndFlush(screen.getByText('Remind Me Later'), () => {
      expect(h.onRemindLater).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('Delete fires onDelete + onClose for a delivered message', async () => {
    const h = await renderOverlay(makeSelected());
    await pressAndFlush(screen.getByText('Delete'), () => {
      expect(h.onDelete).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('hides Delete on an optimistic in-flight own message (Cancel Sending is offered instead)', async () => {
    await renderOverlay(makeSelected({ isFromMe: true, sendState: 'sending' }));
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.getByText('Cancel Sending')).toBeTruthy();
  });
});

describe('MessageActionsOverlay — text-gated actions (Copy / Forward)', () => {
  it('shows Copy + Forward and fires their callbacks when there is text', async () => {
    const h = await renderOverlay(makeSelected({ text: 'hello world' }));
    await pressAndFlush(screen.getByText('Copy'), () => expect(h.onCopy).toHaveBeenCalledTimes(1));
    await pressAndFlush(screen.getByText('Forward'), () =>
      expect(h.onForward).toHaveBeenCalledTimes(1),
    );
    // both close the sheet
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it('hides Copy + Forward when the message has no trimmed text (and no attachments)', async () => {
    await renderOverlay(makeSelected({ text: '   ' }));
    expect(screen.queryByText('Copy')).toBeNull();
    expect(screen.queryByText('Forward')).toBeNull();
  });

  it('hides Copy but keeps Forward for an attachment-only message', async () => {
    // Forward now covers attachments too (the action itself decides between navigating with
    // the downloaded files and the "download it first" notice) — only Copy is text-gated.
    const h = await renderOverlay(
      makeSelected({
        text: null,
        attachments: [{ guid: 'a1', localPath: null, mimeType: 'image/jpeg' }],
      }),
    );
    expect(screen.queryByText('Copy')).toBeNull();
    await pressAndFlush(screen.getByText('Forward'), () =>
      expect(h.onForward).toHaveBeenCalledTimes(1),
    );
  });
});

describe('MessageActionsOverlay — Save to Photos (attachment-gated)', () => {
  it('shows Save to Photos and fires onSave when there are attachments', async () => {
    const h = await renderOverlay(
      makeSelected({ attachments: [{ guid: 'a1', localPath: '/x.jpg', mimeType: 'image/jpeg' }] }),
    );
    await pressAndFlush(screen.getByText('Save to Photos'), () => {
      expect(h.onSave).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('hides Save to Photos when there are no attachments', async () => {
    await renderOverlay(makeSelected({ attachments: [] }));
    expect(screen.queryByText('Save to Photos')).toBeNull();
  });
});

describe('MessageActionsOverlay — View Thread + Select', () => {
  it('shows View Thread only for a message in a thread, and fires onViewThread', async () => {
    const h = await renderOverlay(makeSelected({ inThread: true }));
    await pressAndFlush(screen.getByText('View Thread'), () => {
      expect(h.onViewThread).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('hides View Thread for a message with no thread', async () => {
    await renderOverlay(makeSelected({ inThread: false }));
    expect(screen.queryByText('View Thread')).toBeNull();
  });

  it('shows View Edit History only for an edited message, and fires onViewEditHistory + onClose', async () => {
    const h = await renderOverlay(makeSelected({ isEdited: true }));
    await pressAndFlush(screen.getByText('View Edit History'), () => {
      expect(h.onViewEditHistory).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('hides View Edit History for a message that was never edited', async () => {
    await renderOverlay(makeSelected({ isEdited: false }));
    expect(screen.queryByText('View Edit History')).toBeNull();
  });

  it('shows View Edit History for ANY edited message, including one from someone else', async () => {
    // Distinct from Edit/Unsend (own-recent only) — you can view the history of a message the
    // other person edited.
    await renderOverlay(makeSelected({ isFromMe: false, isEdited: true }));
    expect(screen.getByText('View Edit History')).toBeTruthy();
  });

  it('Select fires onSelect + onClose (multi-select entry)', async () => {
    const h = await renderOverlay(makeSelected());
    await pressAndFlush(screen.getByText('Select'), () => {
      expect(h.onSelect).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('MessageActionsOverlay — Share', () => {
  it('shows Share and fires onShare for a message with text', async () => {
    const h = await renderOverlay(makeSelected({ text: 'hi there' }));
    await pressAndFlush(screen.getByText('Share…'), () => {
      expect(h.onShare).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows Share for an attachment-only message (no text)', async () => {
    await renderOverlay(
      makeSelected({
        text: null,
        attachments: [{ guid: 'a1', localPath: '/x.jpg', mimeType: 'image/jpeg' }],
      }),
    );
    expect(screen.getByText('Share…')).toBeTruthy();
  });

  it('hides Share when the message has neither text nor attachments', async () => {
    await renderOverlay(makeSelected({ text: null, attachments: [] }));
    expect(screen.queryByText('Share…')).toBeNull();
  });
});

describe('MessageActionsOverlay — Edit / Unsend (own recent message)', () => {
  const ownRecent = (o: Partial<SelectedMessage> = {}) =>
    makeSelected({
      isFromMe: true,
      isTemp: false,
      isRetracted: false,
      dateCreated: Date.now(),
      ...o,
    });

  it('shows Edit + Unsend for an own recent iMessage with text and fires the callbacks', async () => {
    const h = await renderOverlay(ownRecent({ text: 'edit me' }));
    await pressAndFlush(screen.getByText('Edit'), () => expect(h.onEdit).toHaveBeenCalledTimes(1));
    await pressAndFlush(screen.getByText('Unsend'), () =>
      expect(h.onUnsend).toHaveBeenCalledTimes(1),
    );
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it('hides Edit (no text) but still shows Unsend for an own recent attachment-only message', async () => {
    await renderOverlay(
      ownRecent({
        text: null,
        attachments: [{ guid: 'a1', localPath: '/x.jpg', mimeType: 'image/jpeg' }],
      }),
    );
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.getByText('Unsend')).toBeTruthy();
  });

  it('hides Edit + Unsend for a message from someone else', async () => {
    await renderOverlay(makeSelected({ isFromMe: false, text: 'hi' }));
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Unsend')).toBeNull();
  });

  it('hides Edit + Unsend once the 15-minute edit window has passed', async () => {
    const stale = Date.now() - 16 * 60_000;
    await renderOverlay(ownRecent({ text: 'too late', dateCreated: stale }));
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Unsend')).toBeNull();
  });

  it('hides Edit + Unsend for a still-temp (not-yet-on-server) message', async () => {
    await renderOverlay(ownRecent({ text: 'pending', isTemp: true }));
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Unsend')).toBeNull();
  });

  it('hides Edit + Unsend for an already-retracted message', async () => {
    await renderOverlay(ownRecent({ text: 'gone', isRetracted: true }));
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Unsend')).toBeNull();
  });

  it('hides Edit + Unsend when dateCreated is null', async () => {
    await renderOverlay(ownRecent({ text: 'x', dateCreated: null }));
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Unsend')).toBeNull();
  });
});

describe('MessageActionsOverlay — Cancel / Remove (optimistic own message)', () => {
  it('shows "Cancel Sending" while an own message is sending and fires onCancelSend', async () => {
    const h = await renderOverlay(
      makeSelected({ isFromMe: true, isTemp: true, sendState: 'sending', text: 'inflight' }),
    );
    await pressAndFlush(screen.getByText('Cancel Sending'), () => {
      expect(h.onCancelSend).toHaveBeenCalledTimes(1);
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows "Remove" (not "Cancel Sending") for an own errored message', async () => {
    const h = await renderOverlay(
      makeSelected({ isFromMe: true, isTemp: true, sendState: 'error', text: 'failed' }),
    );
    expect(screen.queryByText('Cancel Sending')).toBeNull();
    await pressAndFlush(screen.getByText('Remove'), () =>
      expect(h.onCancelSend).toHaveBeenCalledTimes(1),
    );
  });

  it('hides the cancel action for an own message that has already sent', async () => {
    await renderOverlay(makeSelected({ isFromMe: true, sendState: 'sent', text: 'done' }));
    expect(screen.queryByText('Cancel Sending')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('hides the cancel action for a message from someone else', async () => {
    await renderOverlay(makeSelected({ isFromMe: false, sendState: 'error', text: 'x' }));
    expect(screen.queryByText('Cancel Sending')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });
});

describe('MessageActionsOverlay — Reduce Motion opening lifecycle', () => {
  const ANCHOR = { x: 24, y: 180, width: 140, height: 44 };

  function overlay(selected: SelectedMessage | null, h: ReturnType<typeof handlers>) {
    return <MessageActionsOverlay selected={selected} {...h} />;
  }

  async function renderClosed(h: ReturnType<typeof handlers> = handlers()) {
    const view = await renderWithTheme(overlay(null, h));
    return { view, h };
  }

  it('keeps an unresolved anchored opening visible and consumed when false resolves later', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const springs = spySprings();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));

      expect(screen.getByText('Reply')).toBeTruthy();
      expect(springs.handles).toHaveLength(0);
      expect(setValue.mock.calls.at(-1)).toEqual([1]);

      await act(async () => {
        query.resolve(false);
        await query.promise;
      });
      expect(springs.handles).toHaveLength(0);

      await act(async () => view.unmount());
    } finally {
      setValue.mockRestore();
      springs.restore();
    }
  });

  it('keeps a known-true opening static and does not replay it when motion is enabled later', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));
      expect(springs.handles).toHaveLength(0);

      await act(async () => reduceMotionListeners[0]!(false));
      expect(springs.handles).toHaveLength(0);
      expect(screen.getByText('Reply')).toBeTruthy();

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it('runs the existing spring once for a new anchored opening when motion is known false', async () => {
    const springs = spySprings();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));

      expect(springs.handles).toHaveLength(1);
      expect(springs.handles[0]!.start).toHaveBeenCalledTimes(1);
      expect(springs.spy.mock.calls[0]![1]).toEqual({
        toValue: 1,
        useNativeDriver: true,
        friction: 9,
        tension: 90,
      });
      expect(setValue.mock.calls.at(-1)).toEqual([0]);

      await act(async () => view.unmount());
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      springs.restore();
    }
  });

  it('animates the next opening when the native query rejects while closed', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('preference unavailable'));
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));

      expect(springs.handles).toHaveLength(1);
      expect(springs.handles[0]!.start).toHaveBeenCalledTimes(1);

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it('does not reverse-pop an unresolved opening when its query later rejects', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));

      await act(async () => {
        query.reject(new Error('preference unavailable'));
        await query.promise.catch(() => undefined);
      });
      expect(springs.handles).toHaveLength(0);
      expect(screen.getByText('Reply')).toBeTruthy();

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it('stops and snaps on live true without replaying or clearing the emoji draft later', async () => {
    const springs = spySprings();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));
      fireEvent.press(screen.getByLabelText('React with any emoji'));
      const input = await screen.findByLabelText('Emoji reaction input');
      fireEvent.changeText(input, '🔥');
      await waitFor(() =>
        expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥'),
      );

      await act(async () => reduceMotionListeners[0]!(true));
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(setValue.mock.calls.at(-1)).toEqual([1]);
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥');

      await act(async () => reduceMotionListeners[0]!(false));
      expect(springs.handles).toHaveLength(1);
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥');

      await act(async () => view.unmount());
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      springs.restore();
    }
  });

  it('stops the old opening and starts one new spring for a different selected guid', async () => {
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ guid: 'm1', anchorRect: ANCHOR }), h));
      await view.rerender(
        overlay(makeSelected({ guid: 'm2', anchorRect: { ...ANCHOR, y: 240 } }), h),
      );

      expect(springs.handles).toHaveLength(2);
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(springs.handles[1]!.start).toHaveBeenCalledTimes(1);
      expect(springs.handles[1]!.stop).not.toHaveBeenCalled();

      await act(async () => view.unmount());
      expect(springs.handles[1]!.stop).toHaveBeenCalledTimes(1);
    } finally {
      springs.restore();
    }
  });

  it('does not replay or reset input for a same-guid anchor object replacement', async () => {
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ guid: 'm1', anchorRect: ANCHOR }), h));
      fireEvent.press(screen.getByLabelText('React with any emoji'));
      const input = await screen.findByLabelText('Emoji reaction input');
      fireEvent.changeText(input, '🔥');
      await waitFor(() =>
        expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥'),
      );

      await view.rerender(overlay(makeSelected({ guid: 'm1', anchorRect: { ...ANCHOR } }), h));
      expect(springs.handles).toHaveLength(1);
      expect(springs.handles[0]!.stop).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥');

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it('treats close then same-guid reopen as a fresh opening', async () => {
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      const selected = makeSelected({ guid: 'm1', anchorRect: ANCHOR });
      await view.rerender(overlay(selected, h));
      await view.rerender(overlay(null, h));
      expect(springs.handles[0]!.stop).toHaveBeenCalledTimes(1);

      await view.rerender(overlay(selected, h));
      expect(springs.handles).toHaveLength(2);
      expect(springs.handles[1]!.start).toHaveBeenCalledTimes(1);

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it('consumes a fallback opening and only animates a later different-guid anchored opening', async () => {
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ guid: 'm1' }), h));
      expect(springs.handles).toHaveLength(0);

      await view.rerender(overlay(makeSelected({ guid: 'm1', anchorRect: ANCHOR }), h));
      expect(springs.handles).toHaveLength(0);

      await view.rerender(
        overlay(makeSelected({ guid: 'm2', anchorRect: { ...ANCHOR, y: 240 } }), h),
      );
      expect(springs.handles).toHaveLength(1);
      expect(springs.handles[0]!.start).toHaveBeenCalledTimes(1);

      await act(async () => view.unmount());
    } finally {
      springs.restore();
    }
  });

  it.each([
    ['false event over stale true query', false, true, 1],
    ['true event over stale false query', true, false, 0],
  ] as const)(
    'keeps a newer %s authoritative for the next opening',
    async (_case, eventValue, staleQueryValue, expectedSprings) => {
      const query = deferred<boolean>();
      mockIsReduceMotionEnabled.mockReturnValue(query.promise);
      const springs = spySprings();
      try {
        const { view, h } = await renderClosed();
        await act(async () => reduceMotionListeners[0]!(eventValue));
        await act(async () => {
          query.resolve(staleQueryValue);
          await query.promise;
        });

        await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));
        expect(springs.handles).toHaveLength(expectedSprings);

        await act(async () => view.unmount());
      } finally {
        springs.restore();
      }
    },
  );

  it('removes the listener and ignores its callback plus a late rejected query after unmount', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const springs = spySprings();
    try {
      const { view, h } = await renderClosed();
      await view.rerender(overlay(makeSelected({ anchorRect: ANCHOR }), h));
      const removedListener = reduceMotionListeners[0]!;
      await act(async () => view.unmount());

      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
      await act(async () => {
        removedListener(false);
        query.reject(new Error('late rejection'));
        await query.promise.catch(() => undefined);
      });
      expect(springs.handles).toHaveLength(0);
    } finally {
      springs.restore();
    }
  });
});
