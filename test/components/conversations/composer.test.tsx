/**
 * Composer (src/ui/conversations/Composer.tsx): the iOS message composer bar. This suite locks in
 * the USER-OBSERVABLE behavior derived from the source:
 *   - the send button appears only when there's trimmed text OR a staged attachment (canSend), and
 *     send fires onSend with the TRIMMED text (effectId undefined) and clears the input;
 *   - the "Send with Return" feature flag (useFeatureSettingsStore — the REAL store via setState)
 *     wires submitBehavior + onSubmitEditing so Enter submits;
 *   - staged-attachment chips render (one "Remove attachment" control each) and removing drops one;
 *   - edit mode replaces the draft temporarily and keeps typed edit text after a refused send;
 *   - the narrow effect picker appears only from a capability-provided long press;
 *   - the themed schedule sheet commits only on explicit confirmation;
 *   - the voice/mic affordance shows only when empty and onStartVoice is provided;
 *   - the debounced typing emitter: true on first keystroke, deduped, false on clear / debounce /
 *     unmount.
 *
 * In-file mocks (mirroring the exemplars' pattern of stubbing native-pulling siblings):
 *   - `@ui/conversations/AttachmentTray`: the real tray imports expo-image-picker /
 *     expo-media-library (native). Composer only routes onPick/onPickFiles through it, so a tiny
 *     stub with two buttons drives both staging paths. (The real tray is covered in
 *     attachmentTray.test.tsx.)
 *   - `expo-image`: the staged image thumbnail uses expo-image; stub it to a plain host View.
 *   - `react-native-safe-area-context`: Composer calls useSafeAreaInsets (needs a provider);
 *     return zero insets.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act, waitFor } from '../support/renderWithTheme';
import type { PendingAttachment } from '@ui/conversations/AttachmentTray';
import type { MessagePreview } from '@db/repositories';

// Zero insets so useSafeAreaInsets() resolves without a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// @expo/vector-icons' Ionicons does an ASYNC font-load that setStates after mount. Once one such
// late setState lands mid-test it trips React's "overlapping act() calls" and corrupts the act
// environment for every subsequent test in the file. Render the glyph synchronously (its `name`
// as text) so there's no deferred setState. (The composer has many icons, so this matters here.)
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

// Staged image thumbnail uses expo-image; render a plain host View instead of the native module.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => React.createElement(View, props) };
});

// The real tray imports native pickers; stub it to buttons that exercise Composer's staging paths.
// `tray-pick-a` stages ONE item; `tray-pick-two` stages TWO in a single press (both onPick calls in
// one React commit → no cross-event async-act overlap); `tray-files` routes to onPickFiles. The
// items must match the top-level ITEM_A/ITEM_B constants by value (toHaveBeenCalledWith deep-equals).
jest.mock('@ui/conversations/AttachmentTray', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const A = { uri: 'file://a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 10 };
  const B = { uri: 'file://b.jpg', name: 'b.jpg', mimeType: 'image/jpeg', size: 20 };
  const btn = (label: string, onPress: () => void) =>
    React.createElement(
      Pressable,
      { accessibilityRole: 'button', accessibilityLabel: label, onPress },
      React.createElement(Text, null, label),
    );
  return {
    ATTACHMENT_TRAY_HEIGHT: 104,
    AttachmentTray: ({
      onPick,
      onPickFiles,
    }: {
      onPick: (i: unknown) => void;
      onPickFiles: () => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        btn('tray-pick-a', () => onPick(A)),
        btn('tray-pick-two', () => {
          onPick(A);
          onPick(B);
        }),
        btn('tray-files', () => onPickFiles()),
      ),
  };
});

// eslint-disable-next-line import/first
import { Composer } from '@ui/conversations/Composer';
// eslint-disable-next-line import/first
import { useFeatureSettingsStore } from '@state/featureSettingsStore';

/** The two items the mock tray stages via onPick (must equal the mock's A/B by value). */
const ITEM_A: PendingAttachment = {
  uri: 'file://a.jpg',
  name: 'a.jpg',
  mimeType: 'image/jpeg',
  size: 10,
};
const ITEM_B: PendingAttachment = {
  uri: 'file://b.jpg',
  name: 'b.jpg',
  mimeType: 'image/jpeg',
  size: 20,
};
/** Two file items resolved by an onPickFiles prop (exercises handlePickFiles + addPending). */
const FILE_A: PendingAttachment = {
  uri: 'file://a.pdf',
  name: 'a.pdf',
  mimeType: 'application/pdf',
  size: 10,
};
const FILE_B: PendingAttachment = {
  uri: 'file://b.mp4',
  name: 'b.mp4',
  mimeType: 'video/mp4',
  size: 20,
};

beforeEach(() => {
  jest.useFakeTimers();
  // setup.ts resets only the theme store; the feature-settings flag is this suite's to control.
  useFeatureSettingsStore.setState({ sendWithReturn: false });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function input() {
  return screen.getByPlaceholderText('iMessage');
}

function retainSchedulePress(): () => void {
  const node = screen.getByRole('button', { name: 'Schedule' });
  const responder = node.props.onStartShouldSetResponder;
  const readConfig = responder?.testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') throw new Error('Expected native Pressable configuration');
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected Schedule handler');
  return () => onPress({ nativeEvent: {} });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const REPLY_TARGET: MessagePreview = {
  guid: 'reply-target',
  text: 'Original message',
  senderName: 'Alice',
  isFromMe: 0,
  hasAttachments: 0,
  targetPartIndex: 0,
};

describe('Composer — typing enables send + trimmed send + clear', () => {
  it('hides the send button until text is typed, then shows it', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByLabelText('Send message')).toBeNull();
    await fireEvent.changeText(input(), 'hello');
    expect(await screen.findByLabelText('Send message')).toBeTruthy();
  });

  it('keeps send hidden for whitespace-only text', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    await fireEvent.changeText(input(), '    ');
    expect(screen.queryByLabelText('Send message')).toBeNull();
  });

  it('fires onSend with the trimmed text (no effect) and clears the field', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    await fireEvent.changeText(input(), '  hey there  ');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('hey there');
    await waitFor(() => expect(input().props.value).toBe(''));
    // The send button disappears once the field is empty again (canSend false).
    await waitFor(() => expect(screen.queryByLabelText('Send message')).toBeNull());
  });

  it('keeps the draft when its captured account owner is no longer current', async () => {
    const onSend = jest.fn();
    const canSubmit = jest.fn(() => true);
    const isSubmitOwnerCurrent = jest.fn(() => false);
    await renderWithTheme(
      <Composer
        onSend={onSend}
        canSubmit={canSubmit}
        isSubmitOwnerCurrent={isSubmitOwnerCurrent}
      />,
    );
    await fireEvent.changeText(input(), 'keep this stale-screen draft');
    await fireEvent.press(await screen.findByLabelText('Send message'));

    expect(isSubmitOwnerCurrent).toHaveBeenCalledTimes(1);
    expect(canSubmit).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(input().props.value).toBe('keep this stale-screen draft');
  });

  it('uses a custom placeholder when provided', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} placeholder="Text Message" />);
    expect(screen.getByPlaceholderText('Text Message')).toBeTruthy();
  });

  it('hides the subject field unless subjectEnabled', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByPlaceholderText('Subject')).toBeNull();
  });

  it('restores a persisted draft into an empty composer', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} initialText="half-typed thought" />);
    expect(await screen.findByDisplayValue('half-typed thought')).toBeTruthy();
  });

  it('clears the draft immediately on send', async () => {
    const onDraftChange = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onDraftChange={onDraftChange} />);
    await fireEvent.changeText(input(), 'about to send');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(''));
  });

  it('retains authored fields until queue admission and ignores a duplicate tap', async () => {
    const firstAdmission = deferred<boolean>();
    const onSend = jest.fn(() => firstAdmission.promise);
    const onDraftChange = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} onDraftChange={onDraftChange} />);
    await fireEvent.changeText(input(), 'keep this offline draft');
    const sendButton = await screen.findByLabelText('Send message');

    await fireEvent.press(sendButton);
    await fireEvent.press(sendButton);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe('keep this offline draft');
    expect(screen.getByLabelText('Send message').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });

    await act(async () => firstAdmission.resolve(false));
    await waitFor(() =>
      expect(screen.getByLabelText('Send message').props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
    expect(input().props.value).toBe('keep this offline draft');
    expect(onDraftChange).not.toHaveBeenCalledWith('');

    onSend.mockReturnValueOnce(Promise.resolve(true));
    await fireEvent.press(screen.getByLabelText('Send message'));
    await waitFor(() => expect(input().props.value).toBe(''));
    expect(onDraftChange).toHaveBeenCalledWith('');
  });

  it('persists the draft after the typing debounce', async () => {
    const onDraftChange = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onDraftChange={onDraftChange} />);
    // RNTL 14 fireEvent is async and supplies its own act scope; awaiting it keeps that scope
    // closed before the fake timer is advanced.
    await fireEvent.changeText(input(), 'brb');
    expect(onDraftChange).not.toHaveBeenCalled(); // debounced
    await act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(onDraftChange).toHaveBeenCalledWith('brb');
  });

  it('has no subject or mention authoring controls and sends ordinary text', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    expect(screen.queryByPlaceholderText('Subject')).toBeNull();
    await fireEvent.changeText(input(), '@Al');
    expect(screen.queryByLabelText('Mention Alice')).toBeNull();
    await fireEvent.press(await screen.findByLabelText('Send message'));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@Al'));
  });

  it('offers proven group participants after @ and submits the exact selected range', async () => {
    const onSend = jest.fn();
    const onSendMention = jest.fn(() => true);
    await renderWithTheme(
      <Composer
        onSend={onSend}
        onSendMention={onSendMention}
        mentionParticipants={[
          { address: 'alice@example.test', label: 'Alice' },
          { address: '+15551234567', label: 'Bob' },
        ]}
      />,
    );

    await fireEvent.changeText(input(), 'Hello @ali');
    await fireEvent.press(await screen.findByLabelText('Mention Alice'));
    expect(input().props.value).toBe('Hello Alice');
    await fireEvent.press(await screen.findByLabelText('Send message'));

    expect(onSendMention).toHaveBeenCalledWith('Hello Alice', [
      { start: 6, length: 5, address: 'alice@example.test' },
    ]);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('preserves a selected mention through temporary inactivity', async () => {
    const onSend = jest.fn();
    const onSendMention = jest.fn(() => true);
    const props = {
      onSend,
      onSendMention,
      mentionParticipants: [
        { address: 'alice@example.test', label: 'Alice' },
        { address: '+15551234567', label: 'Bob' },
      ],
    };
    const view = await renderWithTheme(<Composer {...props} />);
    await fireEvent.changeText(input(), 'Hello @ali');
    await fireEvent.press(await screen.findByLabelText('Mention Alice'));
    await view.rerender(<Composer {...props} active={false} />);
    expect(input().props.value).toBe('Hello Alice');
    expect(screen.queryByLabelText('Mention Alice')).toBeNull();
    await view.rerender(<Composer {...props} active />);
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSendMention).toHaveBeenCalledWith('Hello Alice', [
      { start: 6, length: 5, address: 'alice@example.test' },
    ]);
    expect(onSend).not.toHaveBeenCalled();
  });

  describe('across reply and edit mode', () => {
    const PARTICIPANTS = [
      { address: 'alice@example.test', label: 'Alice' },
      { address: '+15551234567', label: 'Bob' },
    ];
    const ALICE = [{ start: 6, length: 5, address: 'alice@example.test' }];

    async function draftMentioningAlice(
      onSend: jest.Mock,
      onSendMention: jest.Mock,
    ): Promise<Awaited<ReturnType<typeof renderWithTheme>>> {
      const view = await renderWithTheme(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={PARTICIPANTS}
        />,
      );
      await fireEvent.changeText(input(), 'Hello @ali');
      await fireEvent.press(await screen.findByLabelText('Mention Alice'));
      return view;
    }

    it('keeps a mention through a cancelled reply', async () => {
      const onSend = jest.fn(() => true);
      const onSendMention = jest.fn(() => true);
      const view = await draftMentioningAlice(onSend, onSendMention);

      // Like the chat screen, a reply withholds mention sending.
      await view.rerender(
        <Composer
          onSend={onSend}
          mentionParticipants={PARTICIPANTS}
          replyTo={REPLY_TARGET}
          onCancelReply={jest.fn()}
        />,
      );
      await view.rerender(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={PARTICIPANTS}
        />,
      );
      await fireEvent.press(await screen.findByLabelText('Send message'));

      expect(onSendMention).toHaveBeenCalledWith('Hello Alice', ALICE);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('sends a reply as plain text, then drops the mention it carried', async () => {
      const onSend = jest.fn(() => true);
      const onSendMention = jest.fn(() => true);
      const view = await draftMentioningAlice(onSend, onSendMention);

      await view.rerender(
        <Composer
          onSend={onSend}
          mentionParticipants={PARTICIPANTS}
          replyTo={REPLY_TARGET}
          onCancelReply={jest.fn()}
        />,
      );
      await fireEvent.press(await screen.findByLabelText('Send message'));
      expect(onSend).toHaveBeenCalledWith('Hello Alice');
      await waitFor(() => expect(input().props.value).toBe(''));

      await view.rerender(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={PARTICIPANTS}
        />,
      );
      await fireEvent.changeText(input(), 'Next message');
      await fireEvent.press(await screen.findByLabelText('Send message'));
      expect(onSend).toHaveBeenLastCalledWith('Next message');
      expect(onSendMention).not.toHaveBeenCalled();
    });

    it('restores a mention after edit mode temporarily replaces the draft', async () => {
      const onSend = jest.fn(() => true);
      const onSendMention = jest.fn(() => true);
      const view = await draftMentioningAlice(onSend, onSendMention);

      await view.rerender(
        <Composer
          onSend={onSend}
          mentionParticipants={PARTICIPANTS}
          editingText="Original message"
          onCancelEdit={jest.fn()}
        />,
      );
      await waitFor(() => expect(input().props.value).toBe('Original message'));
      await view.rerender(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={PARTICIPANTS}
        />,
      );
      await waitFor(() => expect(input().props.value).toBe('Hello Alice'));
      await fireEvent.press(await screen.findByLabelText('Send message'));

      expect(onSendMention).toHaveBeenCalledWith('Hello Alice', ALICE);
    });
  });

  it('dismisses an unfinished mention query across inactivity without losing draft text', async () => {
    const props = {
      onSend: jest.fn(),
      onSendMention: jest.fn(() => true),
      mentionParticipants: [
        { address: 'alice@example.test', label: 'Alice' },
        { address: '+15551234567', label: 'Bob' },
      ],
    };
    const view = await renderWithTheme(<Composer {...props} />);
    await fireEvent.changeText(input(), 'Hello @ali');
    expect(await screen.findByLabelText('Mention Alice')).toBeTruthy();
    await view.rerender(<Composer {...props} active={false} />);
    await view.rerender(<Composer {...props} active />);
    expect(input().props.value).toBe('Hello @ali');
    expect(screen.queryByLabelText('Mention Alice')).toBeNull();
  });

  it.each([true, false])(
    'drops stale mention metadata when the roster changes while active=%s',
    async (active) => {
      const onSend = jest.fn(() => true);
      const onSendMention = jest.fn(() => true);
      const view = await renderWithTheme(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={[
            { address: 'alice@example.test', label: 'Alice' },
            { address: '+15551234567', label: 'Bob' },
          ]}
        />,
      );

      await fireEvent.changeText(input(), 'Hello @ali');
      await fireEvent.press(await screen.findByLabelText('Mention Alice'));
      await view.rerender(
        <Composer
          active={active}
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={[
            { address: 'charlie@example.test', label: 'Charlie' },
            { address: '+15557654321', label: 'Dana' },
          ]}
        />,
      );
      await view.rerender(
        <Composer
          onSend={onSend}
          onSendMention={onSendMention}
          mentionParticipants={[
            { address: 'charlie@example.test', label: 'Charlie' },
            { address: '+15557654321', label: 'Dana' },
          ]}
        />,
      );
      await fireEvent.press(await screen.findByLabelText('Send message'));

      expect(onSend).toHaveBeenCalledWith('Hello Alice');
      expect(onSendMention).not.toHaveBeenCalled();
    },
  );
});

describe('Composer — formatted messages', () => {
  it('formats only the selected text and submits through the dedicated callback', async () => {
    const onSend = jest.fn();
    const onSendFormatted = jest.fn(() => true);
    const view = await renderWithTheme(
      <Composer onSend={onSend} onSendFormatted={onSendFormatted} />,
    );

    await fireEvent.changeText(input(), 'Hello world');
    await fireEvent(input(), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 5 } },
    });
    await fireEvent.press(await screen.findByLabelText('Bold'));
    expect(screen.getByTestId('formatting-toolbar').props.accessibilityLabel).toBeUndefined();
    expect(screen.getByLabelText('Bold').props.accessibilityState.selected).toBe(true);

    await view.rerender(
      <Composer active={false} onSend={onSend} onSendFormatted={onSendFormatted} />,
    );
    expect(screen.queryByLabelText('Bold')).toBeNull();
    await view.rerender(<Composer active onSend={onSend} onSendFormatted={onSendFormatted} />);
    expect((await screen.findByLabelText('Bold')).props.accessibilityState.selected).toBe(true);

    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSendFormatted).toHaveBeenCalledWith('Hello world', [
      { start: 0, length: 5, styles: ['bold'] },
    ]);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('keeps formatting through a refused reply and never sends that reply as formatted', async () => {
    const onSend = jest.fn(() => false);
    const onSendFormatted = jest.fn(() => true);
    const view = await renderWithTheme(
      <Composer onSend={onSend} onSendFormatted={onSendFormatted} />,
    );
    await fireEvent.changeText(input(), 'Hello world');
    await fireEvent(input(), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 5 } },
    });
    await fireEvent.press(await screen.findByLabelText('Bold'));

    await view.rerender(
      <Composer onSend={onSend} replyTo={REPLY_TARGET} onCancelReply={jest.fn()} />,
    );
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('Hello world');
    expect(onSendFormatted).not.toHaveBeenCalled();
    expect(input().props.value).toBe('Hello world');

    await view.rerender(<Composer onSend={onSend} onSendFormatted={onSendFormatted} />);
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSendFormatted).toHaveBeenCalledWith('Hello world', [
      { start: 0, length: 5, styles: ['bold'] },
    ]);
  });

  it('consumes retained formatting after an admitted plain reply', async () => {
    const onSend = jest.fn(() => true);
    const onSendFormatted = jest.fn(() => true);
    const view = await renderWithTheme(
      <Composer onSend={onSend} onSendFormatted={onSendFormatted} />,
    );
    await fireEvent.changeText(input(), 'Hello world');
    await fireEvent(input(), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 5 } },
    });
    await fireEvent.press(await screen.findByLabelText('Bold'));

    await view.rerender(
      <Composer onSend={onSend} replyTo={REPLY_TARGET} onCancelReply={jest.fn()} />,
    );
    await fireEvent.press(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(input().props.value).toBe(''));

    await view.rerender(<Composer onSend={onSend} onSendFormatted={onSendFormatted} />);
    await fireEvent.changeText(input(), 'Next message');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenLastCalledWith('Next message');
    expect(onSendFormatted).not.toHaveBeenCalled();
  });

  it('restores the formatted draft after edit mode temporarily replaces its text', async () => {
    const onSend = jest.fn(() => false);
    const onSendFormatted = jest.fn(() => true);
    const onCancelEdit = jest.fn();
    const onRemovalStateChange = jest.fn();
    const view = await renderWithTheme(
      <Composer
        onSend={onSend}
        onSendFormatted={onSendFormatted}
        onRemovalStateChange={onRemovalStateChange}
      />,
    );
    await fireEvent.changeText(input(), 'Hello world');
    await fireEvent(input(), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 5 } },
    });
    await fireEvent.press(await screen.findByLabelText('Bold'));

    await view.rerender(
      <Composer
        onSend={onSend}
        editingText="Original message"
        onCancelEdit={onCancelEdit}
        onRemovalStateChange={onRemovalStateChange}
      />,
    );
    await waitFor(() => expect(input().props.value).toBe('Original message'));
    await waitFor(() =>
      expect(onRemovalStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hasUnsavedDraftMetadata: true,
          hasUnsavedFormattingMetadata: true,
        }),
      ),
    );
    await fireEvent.changeText(input(), 'Changed edit');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('Changed edit');
    expect(onSendFormatted).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('Cancel edit'));
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    await view.rerender(
      <Composer
        onSend={onSend}
        replyTo={REPLY_TARGET}
        onCancelReply={jest.fn()}
        onRemovalStateChange={onRemovalStateChange}
      />,
    );
    await waitFor(() => expect(input().props.value).toBe('Hello world'));
    await view.rerender(
      <Composer
        onSend={onSend}
        onSendFormatted={onSendFormatted}
        onRemovalStateChange={onRemovalStateChange}
      />,
    );
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSendFormatted).toHaveBeenCalledWith('Hello world', [
      { start: 0, length: 5, styles: ['bold'] },
    ]);
  });

  it('drops formatting when the formatted capability truly disappears', async () => {
    const onSend = jest.fn(() => false);
    const onSendFormatted = jest.fn(() => true);
    const view = await renderWithTheme(
      <Composer onSend={onSend} onSendFormatted={onSendFormatted} />,
    );
    await fireEvent.changeText(input(), 'Hello world');
    await fireEvent(input(), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 5 } },
    });
    await fireEvent.press(await screen.findByLabelText('Bold'));

    await view.rerender(<Composer onSend={onSend} />);
    await view.rerender(<Composer onSend={onSend} onSendFormatted={onSendFormatted} />);
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('Hello world');
    expect(onSendFormatted).not.toHaveBeenCalled();
  });
});

describe('Composer — send-with-return feature flag (real store)', () => {
  it('does NOT submit on Enter when the flag is off (default)', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    await fireEvent.changeText(input(), 'via return');
    // Flush the controlled-value re-render before firing the next act-wrapped event, or React
    // 19's still-open async act from changeText overlaps this one ("overlapping act() calls").
    await screen.findByDisplayValue('via return');
    await fireEvent(input(), 'submitEditing');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('submits on Enter when the flag is on', async () => {
    useFeatureSettingsStore.setState({ sendWithReturn: true });
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    await fireEvent.changeText(input(), 'via return');
    await screen.findByDisplayValue('via return'); // flush before submitEditing (see note above)
    await fireEvent(input(), 'submitEditing');
    expect(onSend).toHaveBeenCalledWith('via return');
  });
});

describe('Composer — narrow edit mode and effect control', () => {
  it('does not expose reply, edit, or send-effect controls outside edit mode', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    await fireEvent.changeText(input(), 'ordinary text');
    const send = await screen.findByLabelText('Send message');

    expect(screen.queryByText(/Replying to/)).toBeNull();
    expect(screen.queryByText('Editing message')).toBeNull();
    expect(send.props.accessibilityHint).toBeUndefined();

    await fireEvent(send, 'longPress');
    expect(screen.queryByText('Send with effect')).toBeNull();
  });

  it('keeps ordinary tap plain while long-press selects an exact effect', async () => {
    const onSend = jest.fn();
    const onSendEffect = jest.fn(() => true);
    await renderWithTheme(<Composer onSend={onSend} onSendEffect={onSendEffect} />);
    await fireEvent.changeText(input(), 'party');
    const send = await screen.findByLabelText('Send message');

    expect(send.props.accessibilityHint).toBe('Long press to choose an iMessage effect');
    await fireEvent.press(send);
    expect(onSend).toHaveBeenCalledWith('party');
    expect(onSendEffect).not.toHaveBeenCalled();

    await fireEvent.changeText(input(), 'boom');
    const effectSend = await screen.findByLabelText('Send message');
    await fireEvent(effectSend, 'longPress');
    expect(await screen.findByText('Send with effect')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Send with Slam effect'));

    expect(onSendEffect).toHaveBeenCalledWith('boom', 'com.apple.MobileSMS.expressivesend.impact');
    expect(onSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('retains effect text after a definite refusal and blocks duplicate submission', async () => {
    const admission = deferred<boolean>();
    const onSendEffect = jest.fn(() => admission.promise);
    await renderWithTheme(<Composer onSend={jest.fn()} onSendEffect={onSendEffect} />);
    await fireEvent.changeText(input(), 'keep my effect draft');
    const send = await screen.findByLabelText('Send message');
    await fireEvent(send, 'longPress');
    await fireEvent.press(await screen.findByLabelText('Send with Loud effect'));

    expect(onSendEffect).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe('keep my effect draft');
    expect(screen.getByLabelText('Send message').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });

    await act(async () => admission.resolve(false));
    await waitFor(() =>
      expect(screen.getByLabelText('Send message').props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
    expect(input().props.value).toBe('keep my effect draft');
  });

  it('does not expose effects while editing', async () => {
    const onSendEffect = jest.fn();
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendEffect={onSendEffect}
        editingText="original"
        onCancelEdit={jest.fn()}
      />,
    );
    await fireEvent.changeText(input(), 'edited');
    const editSend = await screen.findByLabelText('Send message');
    expect(editSend.props.accessibilityHint).toBeUndefined();
    await fireEvent(editSend, 'longPress');
    expect(screen.queryByText('Send with effect')).toBeNull();
  });

  it('does not expose effects when an attachment is staged', async () => {
    const onSendEffect = jest.fn();
    await renderWithTheme(
      <Composer onSend={jest.fn()} onSendEffect={onSendEffect} onSendAttachments={jest.fn()} />,
    );
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await fireEvent.changeText(input(), 'caption');
    const attachmentSend = await screen.findByLabelText('Send message');
    expect(attachmentSend.props.accessibilityHint).toBeUndefined();
    await fireEvent(attachmentSend, 'longPress');
    expect(screen.queryByText('Send with effect')).toBeNull();
  });

  it('keeps the typed edit after a definite refusal and ignores a duplicate tap', async () => {
    const admission = deferred<boolean>();
    const onSend = jest.fn(() => admission.promise);
    const onDraftChange = jest.fn();
    await renderWithTheme(
      <Composer
        onSend={onSend}
        initialText="ordinary draft"
        editingText="original message"
        onCancelEdit={jest.fn()}
        onDraftChange={onDraftChange}
      />,
    );

    expect(await screen.findByDisplayValue('original message')).toBeTruthy();
    expect(screen.getByText('Editing message')).toBeTruthy();
    await fireEvent.changeText(input(), 'typed edit to keep');
    const send = await screen.findByLabelText('Send message');
    await fireEvent.press(send);
    await fireEvent.press(send);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('typed edit to keep');
    expect(input().props.value).toBe('typed edit to keep');

    await act(async () => admission.resolve(false));
    await waitFor(() =>
      expect(screen.getByLabelText('Send message').props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
    expect(input().props.value).toBe('typed edit to keep');
    expect(screen.getByText('Editing message')).toBeTruthy();
    expect(onDraftChange).not.toHaveBeenCalledWith('typed edit to keep');
  });
});

describe('Composer — staged attachments', () => {
  it('reports an empty open tray and lets route Back close it', async () => {
    const onRemovalStateChange = jest.fn();
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={jest.fn()}
        onRemovalStateChange={onRemovalStateChange}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Open attachment options'));

    await waitFor(() =>
      expect(onRemovalStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hasUnsavedDraftMetadata: false,
          hasOpenAttachmentTray: true,
          dismissAttachmentTray: expect.any(Function),
        }),
      ),
    );
    const openState = onRemovalStateChange.mock.calls.at(-1)?.[0];
    await act(async () => openState?.dismissAttachmentTray());

    await waitFor(() =>
      expect(onRemovalStateChange).toHaveBeenLastCalledWith({
        hasUnsavedDraftMetadata: false,
        hasOpenAttachmentTray: false,
      }),
    );
    expect(screen.queryByLabelText('tray-pick-a')).toBeNull();
  });

  it('keeps combined authored text and attachment when capacity refuses the one logical job', async () => {
    const canSubmit = jest.fn(() => false);
    const onSendAttachments = jest.fn();
    const onSendTextAttachment = jest.fn();
    const onSend = jest.fn();
    const onDraftChange = jest.fn();
    await renderWithTheme(
      <Composer
        onSend={onSend}
        onSendAttachments={onSendAttachments}
        onSendTextAttachment={onSendTextAttachment}
        canSubmit={canSubmit}
        onDraftChange={onDraftChange}
      />,
    );
    await fireEvent.changeText(input(), 'keep this exact draft');
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));

    await fireEvent.press(screen.getByLabelText('Send message'));

    expect(canSubmit).toHaveBeenCalledWith(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendAttachments).not.toHaveBeenCalled();
    expect(onSendTextAttachment).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalledWith('');
    expect(input().props.value).toBe('keep this exact draft');
    expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1);
  });

  it('removes only attachments whose queue rows committed', async () => {
    const admission = deferred<readonly string[]>();
    const onSendAttachments = jest.fn(() => admission.promise);
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={onSendAttachments} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-two'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));

    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2);

    await act(async () => admission.resolve([ITEM_A.uri]));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
    expect(onSendAttachments).toHaveBeenCalledWith([ITEM_A, ITEM_B]);
  });

  it('ignores a late attachment admission after the captured account retires', async () => {
    const admission = deferred<readonly string[]>();
    let ownerCurrent = true;
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={() => admission.promise}
        isSubmitOwnerCurrent={() => ownerCurrent}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));

    await fireEvent.press(screen.getByLabelText('Send message'));
    ownerCurrent = false;
    await act(async () => admission.resolve([ITEM_A.uri]));

    expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1);
  });

  it('stages two items as chips, enables send with empty text, and sends the attachments only', async () => {
    const onSendAttachments = jest.fn();
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} onSendAttachments={onSendAttachments} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options')); // open tray
    await fireEvent.press(await screen.findByLabelText('tray-pick-two')); // stage A + B in one commit
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));

    // Empty text but staged attachments → send is enabled and sends the attachments only.
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSendAttachments).toHaveBeenCalledWith([ITEM_A, ITEM_B]);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText('Remove attachment')).toBeNull());
  });

  it('stages a single item picked from the tray thumbnails', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('seeds initialAttachments into the tray on mount (Direct Share INTO this chat)', async () => {
    const onSendAttachments = jest.fn();
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={onSendAttachments}
        initialAttachments={[ITEM_A]}
      />,
    );
    // The shared photo shows as a staged chip with NO tray interaction, and send is enabled.
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSendAttachments).toHaveBeenCalledWith([ITEM_A]);
  });

  it('does not stage the same uri twice (dedupe by uri)', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    const pick = await screen.findByLabelText('tray-pick-a');
    await fireEvent.press(pick);
    // Flush the first press's re-render before the second, or its still-open act overlaps this one.
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
    await fireEvent.press(pick); // dedupes → no state change → still one chip
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('stages files chosen via the document picker (handlePickFiles → onPickFiles)', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={jest.fn()}
        onPickFiles={() => Promise.resolve([FILE_A, FILE_B])}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    const files = await screen.findByLabelText('tray-files');
    // Await RNTL 14's async event so its act scope also contains the resolved picker Promise.
    await fireEvent.press(files);
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
  });

  it('removes a staged chip when its remove control is pressed', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-two'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
    await fireEvent.press(screen.getAllByLabelText('Remove attachment')[0]!);
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('hides the attach button entirely when onSendAttachments is not provided', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByLabelText('Open attachment options')).toBeNull();
  });

  it('retains text and file without sending either when attachment support retires', async () => {
    const onSend = jest.fn();
    const view = await renderWithTheme(<Composer onSend={onSend} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getByLabelText('Remove attachment')).toBeTruthy());

    await view.rerender(<Composer onSend={onSend} />);

    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(screen.queryByLabelText('Open attachment options')).toBeNull();
    expect(screen.queryByLabelText('Send message')).toBeNull();

    await fireEvent.changeText(input(), 'plain text survives');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).not.toHaveBeenCalled();
    expect(input().props.value).toBe('plain text survives');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Remove attachment'));
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('plain text survives');
  });

  it('does not stage a document picker result that resolves after attachment support retires', async () => {
    const picked = deferred<PendingAttachment[]>();
    const view = await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={jest.fn()}
        onPickFiles={() => picked.promise}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Open attachment options'));
    await fireEvent.press(await screen.findByLabelText('tray-files'));

    await view.rerender(<Composer onSend={jest.fn()} />);
    await act(async () => picked.resolve([FILE_A]));

    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });
});

describe('Composer — themed scheduling', () => {
  const future = new Date(2035, 6, 15, 9, 15).getTime();
  async function chooseTime(): Promise<void> {
    await fireEvent.changeText(screen.getByLabelText('Schedule date'), '2035-07-15');
    await fireEvent.changeText(screen.getByLabelText('Schedule time'), '09:15');
  }

  it('shows the schedule control after typing and commits once only on Schedule', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    expect(screen.queryByLabelText('Schedule message')).toBeNull();
    await fireEvent.changeText(input(), '  later  ');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    await chooseTime();
    expect(onSchedule).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSchedule).toHaveBeenCalledWith('later', future, null);
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe('');
  });

  it('keeps the text until the schedule is saved, then clears the saved draft too', async () => {
    const saved = deferred<boolean>();
    const onSchedule = jest.fn(() => saved.promise);
    const onDraftChange = jest.fn();
    await renderWithTheme(
      <Composer onSend={jest.fn()} onSchedule={onSchedule} onDraftChange={onDraftChange} />,
    );
    await fireEvent.changeText(input(), 'see you at nine');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));

    expect(onSchedule).toHaveBeenCalledWith('see you at nine', future, null);
    expect(input().props.value).toBe('see you at nine');

    await act(async () => saved.resolve(true));
    await waitFor(() => expect(input().props.value).toBe(''));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(''));
  });

  it('keeps the text when the schedule could not be saved', async () => {
    const onSchedule = jest.fn(async () => false);
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'keep for later');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(input().props.value).toBe('keep for later');
  });

  it('changing repeat does not send until the separate Schedule action', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'daily later');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    await chooseTime();
    await fireEvent.press(screen.getByRole('radio', { name: 'Repeat daily' }));
    expect(onSchedule).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSchedule).toHaveBeenCalledWith('daily later', future, 'daily');
  });

  it('Cancel keeps the exact draft and a new opening starts with no repeat', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), '  keep me  ');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Repeat daily' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Schedule date')).toBeNull();
    expect(onSchedule).not.toHaveBeenCalled();
    expect(input().props.value).toBe('  keep me  ');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    expect(screen.getByRole('radio', { name: 'Send once' }).props.accessibilityState.checked).toBe(
      true,
    );
  });

  it.each(['inactive', 'reply', 'edit', 'capability'] as const)(
    'invalidates an open schedule across %s and does not revive it on restoration',
    async (reason) => {
      const onSchedule = jest.fn(),
        onSend = jest.fn();
      const props = { onSend, onSchedule };
      const view = await renderWithTheme(<Composer {...props} />);
      await fireEvent.changeText(input(), 'keep this draft');
      await fireEvent.press(screen.getByLabelText('Schedule message'));
      const confirm = retainSchedulePress();
      const revoked =
        reason === 'inactive'
          ? { active: false }
          : reason === 'reply'
            ? { replyTo: REPLY_TARGET }
            : reason === 'edit'
              ? { editingText: 'edit target' }
              : { onSchedule: undefined };
      await view.rerender(<Composer {...props} {...revoked} />);
      await act(async () => confirm());
      await view.rerender(<Composer {...props} />);
      await act(async () => confirm());
      expect(onSchedule).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Schedule date')).toBeNull();
      expect(input().props.value).toBe('keep this draft');
    },
  );

  it('checks live account ownership at confirmation without needing another render', async () => {
    let current = true;
    const onSchedule = jest.fn();
    await renderWithTheme(
      <Composer onSend={jest.fn()} onSchedule={onSchedule} isSubmitOwnerCurrent={() => current} />,
    );
    await fireEvent.changeText(input(), 'keep old account draft');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    const confirm = retainSchedulePress();
    current = false;
    await act(async () => confirm());
    expect(onSchedule).not.toHaveBeenCalled();
    expect(input().props.value).toBe('keep old account draft');
  });

  it.each(['owner', 'callback'] as const)(
    'rejects replacement %s with the identical draft',
    async (replacement) => {
      const ownerA = jest.fn(() => true);
      const ownerB = jest.fn(() => true);
      const scheduleA = jest.fn(),
        scheduleB = jest.fn(),
        onSend = jest.fn();
      const view = await renderWithTheme(
        <Composer onSend={onSend} onSchedule={scheduleA} isSubmitOwnerCurrent={ownerA} />,
      );
      await fireEvent.changeText(input(), 'identical draft');
      await fireEvent.press(screen.getByLabelText('Schedule message'));
      const confirm = retainSchedulePress();
      await view.rerender(
        <Composer
          onSend={onSend}
          onSchedule={replacement === 'callback' ? scheduleB : scheduleA}
          isSubmitOwnerCurrent={replacement === 'owner' ? ownerB : ownerA}
        />,
      );
      await act(async () => confirm());
      expect(scheduleA).not.toHaveBeenCalled();
      expect(scheduleB).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Schedule date')).toBeNull();
      expect(input().props.value).toBe('identical draft');
    },
  );

  it('retains the admitting owner through a delayed file schedule result', async () => {
    const result = deferred<boolean>();
    const ownerA = jest.fn(() => true),
      ownerB = jest.fn(() => true);
    const scheduleA = jest.fn(() => result.promise),
      scheduleB = jest.fn();
    const props = { onSend: jest.fn(), onSendAttachments: jest.fn(), initialAttachments: [FILE_A] };
    const view = await renderWithTheme(
      <Composer {...props} onScheduleAttachment={scheduleA} isSubmitOwnerCurrent={ownerA} />,
    );
    await fireEvent.changeText(input(), 'identical caption');
    await fireEvent.press(screen.getByLabelText('Schedule attachment'));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(scheduleA).toHaveBeenCalledTimes(1);
    ownerA.mockReturnValue(false);
    await view.rerender(
      <Composer {...props} onScheduleAttachment={scheduleB} isSubmitOwnerCurrent={ownerB} />,
    );
    await act(async () => result.resolve(true));
    expect(input().props.value).toBe('identical caption');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(scheduleB).not.toHaveBeenCalled();
  });

  it('does not submit a replaced draft through a retained confirmation', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'old draft');
    const composerInput = input();
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    const confirm = retainSchedulePress();
    await fireEvent.changeText(composerInput, 'new draft');
    await act(async () => confirm());
    expect(onSchedule).not.toHaveBeenCalled();
    expect(input().props.value).toBe('new draft');
  });

  it('consumes confirmation identity synchronously and rejects callbacks after unmount', async () => {
    const onSchedule = jest.fn();
    const view = await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'once');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    const confirm = retainSchedulePress();
    await act(async () => {
      confirm();
      confirm();
    });
    expect(onSchedule).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(input(), 'leave unsent');
    await fireEvent.press(screen.getByLabelText('Schedule message'));
    const abandoned = retainSchedulePress();
    await view.unmount();
    await act(async () => abandoned());
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  it('preserves a staged file and caption on Cancel and on rejected scheduling', async () => {
    const onScheduleAttachment = jest.fn().mockResolvedValue(false);
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={jest.fn()}
        onScheduleAttachment={onScheduleAttachment}
        initialAttachments={[FILE_A]}
      />,
    );
    await fireEvent.changeText(input(), 'file caption');
    await fireEvent.press(screen.getByLabelText('Schedule attachment'));
    expect(screen.queryByText('Repeat daily')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(input().props.value).toBe('file caption');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(onScheduleAttachment).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Schedule attachment'));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(onScheduleAttachment).toHaveBeenCalledWith('file caption', FILE_A, future);
    expect(input().props.value).toBe('file caption');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
  });

  it('invalidates a file schedule when its staged file is removed', async () => {
    const onScheduleAttachment = jest.fn().mockResolvedValue(true);
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSendAttachments={jest.fn()}
        onScheduleAttachment={onScheduleAttachment}
        initialAttachments={[FILE_A]}
      />,
    );
    const remove = screen.getByLabelText('Remove attachment');
    await fireEvent.press(screen.getByLabelText('Schedule attachment'));
    const confirm = retainSchedulePress();
    await fireEvent.press(remove);
    await act(async () => confirm());
    expect(onScheduleAttachment).not.toHaveBeenCalled();
  });
});

describe('Composer — voice/mic affordance', () => {
  it('shows the mic when empty + onStartVoice provided, and fires it', async () => {
    const onStartVoice = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onStartVoice={onStartVoice} />);
    const mic = screen.getByLabelText('Record voice message');
    await fireEvent.press(mic);
    expect(onStartVoice).toHaveBeenCalledTimes(1);
  });

  it('hides the mic once text is typed (send takes its place)', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onStartVoice={jest.fn()} />);
    await fireEvent.changeText(input(), 'hi');
    await screen.findByLabelText('Send message');
    expect(screen.queryByLabelText('Record voice message')).toBeNull();
  });
});

describe('Composer — typing indicator (debounced emit)', () => {
  it('emits typing=true on the first keystroke, dedupes, and =false when cleared', async () => {
    const onTyping = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    // onTyping fires synchronously inside onChangeText (before any re-render), so assert then flush
    // the controlled-value re-render before the next changeText, or consecutive acts overlap.
    await fireEvent.changeText(input(), 'a');
    expect(onTyping).toHaveBeenCalledWith(true);
    await screen.findByDisplayValue('a');
    onTyping.mockClear();
    await fireEvent.changeText(input(), 'ab');
    expect(onTyping).not.toHaveBeenCalled(); // already active → no repeat emit
    await screen.findByDisplayValue('ab');
    await fireEvent.changeText(input(), '');
    expect(onTyping).toHaveBeenCalledWith(false);
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('emits typing=false after the 3s debounce window', async () => {
    const onTyping = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    await fireEvent.changeText(input(), 'hi');
    expect(onTyping).toHaveBeenCalledWith(true);
    onTyping.mockClear();
    await act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(onTyping).toHaveBeenCalledWith(false);
  });

  it('emits typing=false on unmount (leaving the chat while typing)', async () => {
    const onTyping = jest.fn();
    const { unmount } = await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    await fireEvent.changeText(input(), 'hi'); // typingActive → true
    expect(onTyping).toHaveBeenCalledWith(true);
    onTyping.mockClear();
    await unmount();
    expect(onTyping).toHaveBeenCalledWith(false);
  });

  it('uses a capability callback that arrives after mount and stops on unmount', async () => {
    const onTyping = jest.fn();
    const view = await renderWithTheme(<Composer onSend={jest.fn()} />);
    await fireEvent.changeText(input(), 'before capability');
    await screen.findByDisplayValue('before capability');
    await view.rerender(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    await fireEvent.changeText(input(), 'after capability');
    expect(onTyping).toHaveBeenCalledWith(true);
    onTyping.mockClear();

    await view.unmount();
    expect(onTyping).toHaveBeenCalledWith(false);
  });

  it('stops the old callback when typing capability disappears', async () => {
    const onTyping = jest.fn();
    const view = await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    await fireEvent.changeText(input(), 'hi');
    expect(onTyping).toHaveBeenCalledWith(true);
    onTyping.mockClear();

    await view.rerender(<Composer onSend={jest.fn()} />);
    expect(onTyping).toHaveBeenCalledWith(false);
  });
});
