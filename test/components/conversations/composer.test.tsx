/**
 * Composer (src/ui/conversations/Composer.tsx): the iOS message composer bar. This suite locks in
 * the USER-OBSERVABLE behavior derived from the source:
 *   - the send button appears only when there's trimmed text OR a staged attachment (canSend), and
 *     send fires onSend with the TRIMMED text (effectId undefined) and clears the input;
 *   - the "Send with Return" feature flag (useFeatureSettingsStore — the REAL store via setState)
 *     wires submitBehavior + onSubmitEditing so Enter submits;
 *   - the reply banner renders "Replying to <who>" + snippet and its close fires onCancelReply;
 *   - edit mode: prefills the input from editingText, shows the "Editing message" bar, hides the
 *     attach/schedule/reply affordances, confirm (send) fires onSend with the edited text, cancel
 *     fires onCancelEdit and clears;
 *   - staged-attachment chips render (one "Remove attachment" control each) and removing drops one;
 *   - the send-effect long-press opens the EffectPicker and picking sends with that effect id;
 *   - the schedule button drives the two-step native date/time picker → onSchedule(text, when);
 *   - the voice/mic affordance shows only when empty + not editing + onStartVoice is provided;
 *   - the debounced typing emitter: true on first keystroke, deduped, false on clear / debounce /
 *     unmount.
 *
 * In-file mocks (mirroring the exemplars' pattern of stubbing native-pulling siblings):
 *   - `@ui/conversations/AttachmentTray`: the real tray imports expo-image-picker /
 *     expo-media-library (native). Composer only routes onPick/onPickFiles through it, so a tiny
 *     stub with two buttons drives both staging paths. (The real tray is covered in
 *     attachmentTray.test.tsx.)
 *   - `@react-native-community/datetimepicker`: DateTimePickerAndroid.open is driven directly so
 *     the two-step schedule flow can be exercised without the native dialog.
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

// Drive the two-step schedule picker directly (no native dialog).
jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));

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
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
// eslint-disable-next-line import/first
import { useFeatureSettingsStore } from '@state/featureSettingsStore';

const openMock = DateTimePickerAndroid.open as unknown as jest.Mock;

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
  // setup.ts resets only the theme store; the feature-settings flag is this suite's to control.
  useFeatureSettingsStore.setState({ sendWithReturn: false });
});

function input() {
  return screen.getByPlaceholderText('iMessage');
}

describe('Composer — typing enables send + trimmed send + clear', () => {
  it('hides the send button until text is typed, then shows it', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByLabelText('Send message')).toBeNull();
    fireEvent.changeText(input(), 'hello');
    expect(await screen.findByLabelText('Send message')).toBeTruthy();
  });

  it('keeps send hidden for whitespace-only text', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    fireEvent.changeText(input(), '    ');
    expect(screen.queryByLabelText('Send message')).toBeNull();
  });

  it('fires onSend with the trimmed text (no effect) and clears the field', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    fireEvent.changeText(input(), '  hey there  ');
    fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('hey there', undefined, undefined, undefined);
    await waitFor(() => expect(input().props.value).toBe(''));
    // The send button disappears once the field is empty again (canSend false).
    await waitFor(() => expect(screen.queryByLabelText('Send message')).toBeNull());
  });

  it('uses a custom placeholder when provided', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} placeholder="Text Message" />);
    expect(screen.getByPlaceholderText('Text Message')).toBeTruthy();
  });

  it('hides the subject field unless subjectEnabled', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByPlaceholderText('Subject')).toBeNull();
  });

  it('carries the subject line when subjectEnabled and a subject is typed', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} subjectEnabled />);
    // Flush each controlled-value re-render before the next act-wrapped event (React 19 overlapping
    // act() — see the send-with-return tests).
    fireEvent.changeText(screen.getByPlaceholderText('Subject'), 'Re: lunch');
    await screen.findByDisplayValue('Re: lunch');
    fireEvent.changeText(input(), 'you around?');
    await screen.findByDisplayValue('you around?');
    fireEvent.press(await screen.findByLabelText('Send message'));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('you around?', undefined, 'Re: lunch', undefined),
    );
    // The subject field clears after send.
    await waitFor(() => expect(screen.getByPlaceholderText('Subject').props.value).toBe(''));
  });

  it('restores a persisted draft into an empty composer', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} initialText="half-typed thought" />);
    expect(await screen.findByDisplayValue('half-typed thought')).toBeTruthy();
  });

  it('clears the draft immediately on send', async () => {
    const onDraftChange = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onDraftChange={onDraftChange} />);
    fireEvent.changeText(input(), 'about to send');
    fireEvent.press(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(''));
  });

  it('persists the draft after the typing debounce', async () => {
    jest.useFakeTimers();
    try {
      const onDraftChange = jest.fn();
      await renderWithTheme(<Composer onSend={jest.fn()} onDraftChange={onDraftChange} />);
      // Under fake timers every state-mutating event must be act-wrapped (see the typing tests),
      // or React's scheduled work is discarded by useRealTimers and later tests can't mount.
      await act(async () => {
        fireEvent.changeText(input(), 'brb');
      });
      expect(onDraftChange).not.toHaveBeenCalled(); // debounced
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(onDraftChange).toHaveBeenCalledWith('brb');
    } finally {
      jest.useRealTimers();
    }
  });

  it('inserts an @mention from the picker and sends the resolved span', async () => {
    const onSend = jest.fn();
    await renderWithTheme(
      <Composer onSend={onSend} mentionParticipants={[{ address: 'a@x.com', name: 'Alice' }]} />,
    );
    fireEvent.changeText(input(), '@Al');
    await screen.findByDisplayValue('@Al');
    // The picker keys off the caret — feed a selectionChange so the @query is detected.
    fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: 3, end: 3 } } });
    fireEvent.press(await screen.findByLabelText('Mention Alice'));
    await screen.findByDisplayValue('@Alice ');
    fireEvent.press(await screen.findByLabelText('Send message'));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('@Alice', undefined, undefined, [
        { start: 0, length: 6, address: 'a@x.com' },
      ]),
    );
  });
});

describe('Composer — send-with-return feature flag (real store)', () => {
  it('does NOT submit on Enter when the flag is off (default)', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    fireEvent.changeText(input(), 'via return');
    // Flush the controlled-value re-render before firing the next act-wrapped event, or React
    // 19's still-open async act from changeText overlaps this one ("overlapping act() calls").
    await screen.findByDisplayValue('via return');
    fireEvent(input(), 'submitEditing');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('submits on Enter when the flag is on', async () => {
    useFeatureSettingsStore.setState({ sendWithReturn: true });
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    fireEvent.changeText(input(), 'via return');
    await screen.findByDisplayValue('via return'); // flush before submitEditing (see note above)
    fireEvent(input(), 'submitEditing');
    expect(onSend).toHaveBeenCalledWith('via return', undefined, undefined, undefined);
  });
});

describe('Composer — reply banner', () => {
  function reply(over: Partial<MessagePreview> = {}): MessagePreview {
    return {
      guid: 'orig',
      text: 'the original',
      senderName: 'Carol',
      isFromMe: 0,
      hasAttachments: 0,
      ...over,
    };
  }

  it('renders "Replying to <name>" with the snippet and fires onCancelReply on dismiss', async () => {
    const onCancelReply = jest.fn();
    await renderWithTheme(
      <Composer onSend={jest.fn()} replyTo={reply()} onCancelReply={onCancelReply} />,
    );
    expect(screen.getByText('Replying to Carol')).toBeTruthy();
    expect(screen.getByText('the original')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Cancel reply'));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('shows "Replying to You" for an own message', async () => {
    await renderWithTheme(
      <Composer onSend={jest.fn()} replyTo={reply({ isFromMe: 1 })} onCancelReply={jest.fn()} />,
    );
    expect(screen.getByText('Replying to You')).toBeTruthy();
  });

  it('uses the attachment placeholder snippet when the replied message has no text', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        replyTo={reply({ text: '', hasAttachments: 1 })}
        onCancelReply={jest.fn()}
      />,
    );
    expect(screen.getByText('📎 Attachment')).toBeTruthy();
  });

  it('falls back to "Unknown" when a received reply has no sender name', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        replyTo={reply({ senderName: null })}
        onCancelReply={jest.fn()}
      />,
    );
    expect(screen.getByText('Replying to Unknown')).toBeTruthy();
  });
});

describe('Composer — edit mode', () => {
  it('prefills the input, shows the Editing bar, and hides attach/reply', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        editingText="edit me"
        onCancelEdit={jest.fn()}
        onSendAttachments={jest.fn()}
        replyTo={{ guid: 'o', text: 't', senderName: 'X', isFromMe: 0, hasAttachments: 0 }}
        onCancelReply={jest.fn()}
      />,
    );
    expect(await screen.findByDisplayValue('edit me')).toBeTruthy();
    expect(screen.getByText('Editing message')).toBeTruthy();
    // Attach button and the reply banner are suppressed while editing.
    expect(screen.queryByLabelText('Attach photo or file')).toBeNull();
    expect(screen.queryByText(/Replying to/)).toBeNull();
  });

  it('confirm (send) fires onSend with the edited text and clears', async () => {
    const onSend = jest.fn();
    await renderWithTheme(
      <Composer onSend={onSend} editingText="original" onCancelEdit={jest.fn()} />,
    );
    await screen.findByDisplayValue('original');
    fireEvent.changeText(input(), 'edited body');
    fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('edited body', undefined, undefined, undefined);
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('cancel fires onCancelEdit and clears the input', async () => {
    const onCancelEdit = jest.fn();
    await renderWithTheme(
      <Composer onSend={jest.fn()} editingText="original" onCancelEdit={onCancelEdit} />,
    );
    await screen.findByDisplayValue('original');
    fireEvent.press(screen.getByLabelText('Cancel edit'));
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('does not open the effect picker on long-press while editing', async () => {
    await renderWithTheme(
      <Composer onSend={jest.fn()} editingText="original" onCancelEdit={jest.fn()} />,
    );
    const send = await screen.findByLabelText('Send message');
    fireEvent(send, 'longPress');
    expect(screen.queryByText('Send with effect')).toBeNull();
  });

  // Regression: starting an edit must not eat an in-progress draft. Before the fix, editing
  // overwrote the input with the edited message and then cleared it to '' on cancel/send,
  // losing the draft (and later persisting '' over kv).
  it('restores the in-progress draft when an edit is cancelled', async () => {
    const { rerender } = await renderWithTheme(
      <Composer onSend={jest.fn()} onCancelEdit={jest.fn()} initialText="draft I was writing" />,
    );
    await screen.findByDisplayValue('draft I was writing');
    // The parent starts an edit → the input prefills with the message being edited.
    rerender(
      <Composer onSend={jest.fn()} onCancelEdit={jest.fn()} editingText="original message" />,
    );
    await screen.findByDisplayValue('original message');
    fireEvent.press(screen.getByLabelText('Cancel edit'));
    // The displaced draft comes back — not a blank box.
    await waitFor(() => expect(input().props.value).toBe('draft I was writing'));
  });

  it('restores the draft after an edit is sent, and never persists it as empty', async () => {
    const onSend = jest.fn();
    const onDraftChange = jest.fn();
    const { rerender } = await renderWithTheme(
      <Composer
        onSend={onSend}
        onCancelEdit={jest.fn()}
        onDraftChange={onDraftChange}
        initialText="draft text"
      />,
    );
    await screen.findByDisplayValue('draft text');
    rerender(
      <Composer
        onSend={onSend}
        onCancelEdit={jest.fn()}
        onDraftChange={onDraftChange}
        editingText="edit this"
      />,
    );
    await screen.findByDisplayValue('edit this');
    fireEvent.changeText(input(), 'edited body');
    fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('edited body', undefined, undefined, undefined);
    // The draft is restored, and the edit never clobbers kv with '' (that would wipe the draft).
    await waitFor(() => expect(input().props.value).toBe('draft text'));
    expect(onDraftChange).not.toHaveBeenCalledWith('');
  });
});

describe('Composer — staged attachments', () => {
  it('stages two items as chips, enables send with empty text, and sends the attachments only', async () => {
    const onSendAttachments = jest.fn();
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} onSendAttachments={onSendAttachments} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file')); // open tray
    fireEvent.press(await screen.findByLabelText('tray-pick-two')); // stage A + B in one commit
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));

    // Empty text but staged attachments → send is enabled and sends the attachments only.
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSendAttachments).toHaveBeenCalledWith([ITEM_A, ITEM_B]);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText('Remove attachment')).toBeNull());
  });

  it('stages a single item picked from the tray thumbnails', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('does not stage the same uri twice (dedupe by uri)', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    const pick = await screen.findByLabelText('tray-pick-a');
    fireEvent.press(pick);
    // Flush the first press's re-render before the second, or its still-open act overlaps this one.
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
    fireEvent.press(pick); // dedupes → no state change → still one chip
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
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    const files = await screen.findByLabelText('tray-files');
    // The picked items arrive via a resolved Promise (.then(addPending)); contain that microtask
    // inside act so the setState doesn't leak past the test and corrupt the next one's act scope.
    await act(async () => {
      fireEvent.press(files);
    });
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
  });

  it('removes a staged chip when its remove control is pressed', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    fireEvent.press(await screen.findByLabelText('tray-pick-two'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
    fireEvent.press(screen.getAllByLabelText('Remove attachment')[0]!);
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('hides the attach button entirely when onSendAttachments is not provided', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByLabelText('Attach photo or file')).toBeNull();
  });
});

describe('Composer — send-effect long-press', () => {
  it('long-pressing send opens the effect picker; picking sends with that effect id', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    fireEvent.changeText(input(), 'party');
    fireEvent(await screen.findByLabelText('Send message'), 'longPress');
    expect(await screen.findByText('Send with effect')).toBeTruthy();
    fireEvent.press(screen.getByText('Slam'));
    expect(onSend).toHaveBeenCalledWith(
      'party',
      'com.apple.MobileSMS.expressivesend.impact',
      undefined,
      undefined,
    );
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('"Send without effect" sends with no effect id', async () => {
    const onSend = jest.fn();
    await renderWithTheme(<Composer onSend={onSend} />);
    fireEvent.changeText(input(), 'plain');
    fireEvent(await screen.findByLabelText('Send message'), 'longPress');
    fireEvent.press(await screen.findByText('Send without effect'));
    expect(onSend).toHaveBeenCalledWith('plain', undefined, undefined, undefined);
  });
});

describe('Composer — schedule (two-step native picker)', () => {
  it('shows the schedule button only after typing and drives date→time→onSchedule', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    expect(screen.queryByLabelText('Schedule message')).toBeNull();
    fireEvent.changeText(input(), 'later');
    fireEvent.press(await screen.findByLabelText('Schedule message'));

    expect(openMock).toHaveBeenCalledTimes(1);
    const dateCfg = openMock.mock.calls[0]![0];
    expect(dateCfg.mode).toBe('date');
    const future = new Date(Date.now() + 2 * 86_400_000);
    act(() => dateCfg.onChange({ type: 'set' }, future));

    expect(openMock).toHaveBeenCalledTimes(2);
    const timeCfg = openMock.mock.calls[1]![0];
    expect(timeCfg.mode).toBe('time');
    act(() => timeCfg.onChange({ type: 'set' }, future));

    expect(onSchedule).toHaveBeenCalledTimes(1);
    const [text, when] = onSchedule.mock.calls[0]!;
    expect(text).toBe('later');
    expect(when).toBeGreaterThan(Date.now());
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('cancelling the date step aborts scheduling (no time picker, no callback)', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    fireEvent.changeText(input(), 'later');
    fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    act(() => dateCfg.onChange({ type: 'dismissed' }, undefined));
    expect(openMock).toHaveBeenCalledTimes(1); // no time picker opened
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('cancelling the time step aborts scheduling', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    fireEvent.changeText(input(), 'later');
    fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    act(() => dateCfg.onChange({ type: 'set' }, new Date(Date.now() + 2 * 86_400_000)));
    const timeCfg = openMock.mock.calls[1]![0];
    act(() => timeCfg.onChange({ type: 'dismissed' }, undefined));
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('rejects a fully-past time (does not schedule)', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    fireEvent.changeText(input(), 'later');
    fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    const past = new Date(Date.now() - 2 * 86_400_000);
    act(() => dateCfg.onChange({ type: 'set' }, past));
    const timeCfg = openMock.mock.calls[1]![0];
    act(() => timeCfg.onChange({ type: 'set' }, past));
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('does not show the schedule button while editing', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onSchedule={jest.fn()}
        editingText="x"
        onCancelEdit={jest.fn()}
      />,
    );
    await screen.findByDisplayValue('x');
    expect(screen.queryByLabelText('Schedule message')).toBeNull();
  });
});

describe('Composer — voice/mic affordance', () => {
  it('shows the mic when empty + onStartVoice provided, and fires it', async () => {
    const onStartVoice = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onStartVoice={onStartVoice} />);
    const mic = screen.getByLabelText('Record voice message');
    fireEvent.press(mic);
    expect(onStartVoice).toHaveBeenCalledTimes(1);
  });

  it('hides the mic once text is typed (send takes its place)', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onStartVoice={jest.fn()} />);
    fireEvent.changeText(input(), 'hi');
    await screen.findByLabelText('Send message');
    expect(screen.queryByLabelText('Record voice message')).toBeNull();
  });

  it('hides the mic while editing', async () => {
    await renderWithTheme(
      <Composer
        onSend={jest.fn()}
        onStartVoice={jest.fn()}
        editingText="x"
        onCancelEdit={jest.fn()}
      />,
    );
    await screen.findByDisplayValue('x');
    expect(screen.queryByLabelText('Record voice message')).toBeNull();
  });
});

describe('Composer — typing indicator (debounced emit)', () => {
  it('emits typing=true on the first keystroke, dedupes, and =false when cleared', async () => {
    const onTyping = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
    // onTyping fires synchronously inside onChangeText (before any re-render), so assert then flush
    // the controlled-value re-render before the next changeText, or consecutive acts overlap.
    fireEvent.changeText(input(), 'a');
    expect(onTyping).toHaveBeenCalledWith(true);
    await screen.findByDisplayValue('a');
    onTyping.mockClear();
    fireEvent.changeText(input(), 'ab');
    expect(onTyping).not.toHaveBeenCalled(); // already active → no repeat emit
    await screen.findByDisplayValue('ab');
    fireEvent.changeText(input(), '');
    expect(onTyping).toHaveBeenCalledWith(false);
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('emits typing=false after the 3s debounce window', async () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      await renderWithTheme(<Composer onSend={jest.fn()} onTyping={onTyping} />);
      await act(async () => {
        fireEvent.changeText(input(), 'hi');
      });
      expect(onTyping).toHaveBeenCalledWith(true);
      onTyping.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits typing=false on unmount (leaving the chat while typing)', async () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      const { unmount } = await renderWithTheme(
        <Composer onSend={jest.fn()} onTyping={onTyping} />,
      );
      await act(async () => {
        fireEvent.changeText(input(), 'hi'); // typingActive → true
      });
      expect(onTyping).toHaveBeenCalledWith(true);
      onTyping.mockClear();
      await act(async () => {
        unmount();
      });
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
