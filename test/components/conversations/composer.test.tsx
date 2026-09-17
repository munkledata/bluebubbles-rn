/**
 * Composer (src/ui/conversations/Composer.tsx): the iOS message composer bar. This suite locks in
 * the USER-OBSERVABLE behavior derived from the source:
 *   - the send button appears only when there's trimmed text OR a staged attachment (canSend), and
 *     send fires onSend with the TRIMMED text (effectId undefined) and clears the input;
 *   - the "Send with Return" feature flag (useFeatureSettingsStore — the REAL store via setState)
 *     wires submitBehavior + onSubmitEditing so Enter submits;
 *   - staged-attachment chips render (one "Remove attachment" control each) and removing drops one;
 *   - retired reply, edit, and send-effect controls stay absent;
 *   - the schedule button drives the two-step native date/time picker → onSchedule(text, when);
 *   - the voice/mic affordance shows only when empty and onStartVoice is provided;
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

describe('Composer — retired helper controls', () => {
  it('does not expose reply, edit, or send-effect controls', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    await fireEvent.changeText(input(), 'ordinary text');
    const send = await screen.findByLabelText('Send message');

    expect(screen.queryByText(/Replying to/)).toBeNull();
    expect(screen.queryByText('Editing message')).toBeNull();
    expect(send.props.accessibilityHint).toBeUndefined();

    await fireEvent(send, 'longPress');
    expect(screen.queryByText('Send with effect')).toBeNull();
  });
});

describe('Composer — staged attachments', () => {
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file')); // open tray
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
    const files = await screen.findByLabelText('tray-files');
    // Await RNTL 14's async event so its act scope also contains the resolved picker Promise.
    await fireEvent.press(files);
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
  });

  it('removes a staged chip when its remove control is pressed', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-two'));
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
    await fireEvent.press(screen.getAllByLabelText('Remove attachment')[0]!);
    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('hides the attach button entirely when onSendAttachments is not provided', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(screen.queryByLabelText('Attach photo or file')).toBeNull();
  });

  it('retains staged files but sends plain text without them when attachment support retires', async () => {
    const onSend = jest.fn();
    const view = await renderWithTheme(<Composer onSend={onSend} onSendAttachments={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
    await fireEvent.press(await screen.findByLabelText('tray-pick-a'));
    await waitFor(() => expect(screen.getByLabelText('Remove attachment')).toBeTruthy());

    await view.rerender(<Composer onSend={onSend} />);

    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
    expect(screen.queryByLabelText('Attach photo or file')).toBeNull();
    expect(screen.queryByLabelText('Send message')).toBeNull();

    await fireEvent.changeText(input(), 'plain text survives');
    await fireEvent.press(await screen.findByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('plain text survives');
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('Attach photo or file'));
    await fireEvent.press(await screen.findByLabelText('tray-files'));

    await view.rerender(<Composer onSend={jest.fn()} />);
    await act(async () => picked.resolve([FILE_A]));

    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });
});

describe('Composer — schedule (two-step native picker + recurrence sheet)', () => {
  it('shows the schedule button only after typing and drives date→time→repeat→onSchedule', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    expect(screen.queryByLabelText('Schedule message')).toBeNull();
    await fireEvent.changeText(input(), 'later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));

    expect(openMock).toHaveBeenCalledTimes(1);
    const dateCfg = openMock.mock.calls[0]![0];
    expect(dateCfg.mode).toBe('date');
    const future = new Date(Date.now() + 2 * 86_400_000);
    await act(() => dateCfg.onChange({ type: 'set' }, future));

    expect(openMock).toHaveBeenCalledTimes(2);
    const timeCfg = openMock.mock.calls[1]![0];
    expect(timeCfg.mode).toBe('time');
    await act(() => timeCfg.onChange({ type: 'set' }, future));

    // Step 3: the recurrence sheet opens; nothing is scheduled until a choice is made.
    expect(onSchedule).not.toHaveBeenCalled();
    await fireEvent.press(await screen.findByText('Send once'));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    const [text, when, recurrence] = onSchedule.mock.calls[0]!;
    expect(text).toBe('later');
    expect(when).toBeGreaterThan(Date.now());
    expect(recurrence).toBeNull(); // "Send once" = one-shot
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('picking a repeat cadence passes it to onSchedule', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'daily later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const future = new Date(Date.now() + 2 * 86_400_000);
    await act(() => openMock.mock.calls[0]![0].onChange({ type: 'set' }, future));
    await act(() => openMock.mock.calls[1]![0].onChange({ type: 'set' }, future));
    await fireEvent.press(await screen.findByText('Repeat daily'));
    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(onSchedule.mock.calls[0]![0]).toBe('daily later');
    expect(onSchedule.mock.calls[0]![2]).toBe('daily');
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('cancelling the recurrence sheet aborts scheduling and keeps the typed text', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'keep me');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const future = new Date(Date.now() + 2 * 86_400_000);
    await act(() => openMock.mock.calls[0]![0].onChange({ type: 'set' }, future));
    await act(() => openMock.mock.calls[1]![0].onChange({ type: 'set' }, future));
    await fireEvent.press(await screen.findByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Send once')).toBeNull());
    expect(onSchedule).not.toHaveBeenCalled();
    expect(input().props.value).toBe('keep me'); // draft not lost on cancel
  });

  it('cancelling the date step aborts scheduling (no time picker, no callback)', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    await act(() => dateCfg.onChange({ type: 'dismissed' }, undefined));
    expect(openMock).toHaveBeenCalledTimes(1); // no time picker opened
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('cancelling the time step aborts scheduling', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    await act(() => dateCfg.onChange({ type: 'set' }, new Date(Date.now() + 2 * 86_400_000)));
    const timeCfg = openMock.mock.calls[1]![0];
    await act(() => timeCfg.onChange({ type: 'dismissed' }, undefined));
    // Same reasoning as the past-time test: the sheet never opened, so a queryBy-null would be
    // vacuous. findBy must run to timeout and reject.
    await expect(screen.findByText('Send once', {}, { timeout: 600 })).rejects.toBeTruthy();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  /**
   * The past-time guard lives at `Composer.tsx`'s `if (when < currentMinute) return;`, which
   * decides whether the RECURRENCE sheet (step 3) opens at all. `onSchedule` only fires after a
   * further "Send once" press, so asserting `onSchedule` alone proves nothing — that assertion
   * held even with the guard deleted (verified by mutation). The sheet's absence is the real
   * discriminator, exactly as the neighbouring cancel test asserts it.
   */
  it('rejects a fully-past time: no recurrence sheet, no schedule', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const dateCfg = openMock.mock.calls[0]![0];
    const past = new Date(Date.now() - 2 * 86_400_000);
    await act(() => dateCfg.onChange({ type: 'set' }, past));
    const timeCfg = openMock.mock.calls[1]![0];
    await act(() => timeCfg.onChange({ type: 'set' }, past));
    // THE discriminating assertion. The sheet is a Modal, so it appears asynchronously —
    // `waitFor(() => expect(queryByText(...)).toBeNull())` is USELESS here because it passes on
    // its first tick, before the sheet could have rendered (verified: that spelling still passed
    // with the guard deleted). Letting findBy run to its timeout and asserting it REJECTS is the
    // assertion that actually fails when the sheet opens.
    await expect(screen.findByText('Send once', {}, { timeout: 600 })).rejects.toBeTruthy();
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('accepts a FUTURE time (proves the guard rejects for the right reason)', async () => {
    const onSchedule = jest.fn();
    await renderWithTheme(<Composer onSend={jest.fn()} onSchedule={onSchedule} />);
    await fireEvent.changeText(input(), 'later');
    await fireEvent.press(await screen.findByLabelText('Schedule message'));
    const future = new Date(Date.now() + 2 * 86_400_000);
    await act(() => openMock.mock.calls[0]![0].onChange({ type: 'set' }, future));
    await act(() => openMock.mock.calls[1]![0].onChange({ type: 'set' }, future));
    // The sheet DOES open here — so the assertion above is sensitive to the guard, not to the
    // fact that the sheet never opens in this flow.
    expect(await screen.findByText('Send once')).toBeTruthy();
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
});
