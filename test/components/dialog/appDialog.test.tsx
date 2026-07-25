/**
 * AppDialog (src/ui/dialog/AppDialog.tsx) driven END-TO-END through the REAL dialog store
 * (src/ui/dialog/dialogStore.ts) — the store is NEVER mocked. Contract exercised here:
 *   - nothing renders while no dialog is active (host returns null);
 *   - showDialog / showAlert / showConfirm set the title + optional message text;
 *   - pressing a button fires that button's onPress AND closes the dialog (store.current → null);
 *   - a cancel button fires its onPress (if any) and closes;
 *   - destructive vs default vs cancel buttons get their themed text color/weight;
 *   - the FIFO queue promotes the next dialog when a button handler opens another;
 *   - the Android hardware-BACK handler (Modal `onRequestClose`) picks the cancel button, and its
 *     no-cancel FALLBACK runs the LAST button (see the two `hardware back` tests below).
 *
 * All store mutations happen inside act() (they cause a mounted AppDialog to re-render); after a
 * fireEvent we assert closure via waitFor (RNTL 14 / React 19 gotcha: no getBy right after an event).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen, fireEvent, act, waitFor } from '../support/renderWithTheme';
import { AppDialog } from '@ui/dialog/AppDialog';
import { useDialogStore, showDialog, showAlert, showConfirm } from '@ui/dialog/dialogStore';
import { resolvePreset, DEFAULT_PRESET } from '@ui/theme/tokens';

// The harness default preset — used to derive the EXPECTED button colors from the source tokens
// rather than hardcoding hex values.
const tokens = resolvePreset(DEFAULT_PRESET);

/** Merge a (possibly array) style prop the way RN does, so we can read the resolved color/weight. */
function flatColor(text: ReturnType<typeof screen.getByText>): string | undefined {
  return StyleSheet.flatten(text.props.style)?.color as string | undefined;
}

/**
 * Fire the Android hardware-back button. RN delivers it to a `<Modal>` as `onRequestClose`, and
 * the Modal IS the rendered root here (AppDialog's outermost element), so we can dispatch straight
 * at `screen.root`. Asserting the root's type + that the handler is wired keeps this honest: if
 * AppDialog ever stops passing `onRequestClose`, the helper fails instead of silently no-opping.
 */
function pressHardwareBack(): void {
  const root = screen.root;
  if (!root) throw new Error('AppDialog rendered nothing — no dialog is active');
  expect(root.type).toBe('Modal');
  expect(typeof root.props.onRequestClose).toBe('function');
  fireEvent(root, 'requestClose');
}

describe('AppDialog (driven through the real dialogStore)', () => {
  beforeEach(() => {
    // setup.ts only resets the theme store; the dialog store is ours to reset. Reset in
    // beforeEach (not afterEach) so we never setState on a still-mounted AppDialog — the
    // shared setup's afterEach cleanup() unmounts the tree; the next test's beforeEach then
    // starts from a cleared store BEFORE it renders.
    useDialogStore.setState({ current: null, queue: [] });
  });

  it('renders nothing while no dialog is active', async () => {
    await renderWithTheme(<AppDialog />);
    expect(screen.queryByText('OK')).toBeNull();
    expect(screen.toJSON()).toBeNull();
  });

  it('showDialog with no buttons renders the title and a single default OK', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showDialog('Heads up');
    });
    expect(await screen.findByText('Heads up')).toBeTruthy();
    // No buttons provided → the store injects one "OK".
    const ok = screen.getByText('OK');
    expect(flatColor(ok)).toBe(tokens.color.tint);
  });

  it('shows the title AND the optional message text', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showDialog('Delete chat?', 'This cannot be undone.');
    });
    expect(await screen.findByText('Delete chat?')).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
  });

  it('omits the message row when no message is given', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showAlert({ title: 'Just a title' });
    });
    expect(await screen.findByText('Just a title')).toBeTruthy();
    // The card should hold only the title text + the button text — no stray secondary line.
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('confirm button fires its onPress and closes the dialog', async () => {
    const onConfirm = jest.fn();
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showConfirm({ title: 'Send now?', confirmText: 'Send', onConfirm });
    });
    fireEvent.press(await screen.findByText('Send'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Send now?')).toBeNull());
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('cancel button fires its onCancel and closes the dialog', async () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showConfirm({ title: 'Discard?', onConfirm, onCancel });
    });
    fireEvent.press(await screen.findByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Discard?')).toBeNull());
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('closes even when a button has no onPress handler', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showDialog('Info', undefined, [{ text: 'Got it', style: 'default' }]);
    });
    fireEvent.press(await screen.findByText('Got it'));
    await waitFor(() => expect(screen.queryByText('Info')).toBeNull());
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('styles destructive, cancel and default buttons distinctly', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showConfirm({
        title: 'Delete forever?',
        confirmText: 'Delete',
        cancelText: 'Keep',
        destructive: true,
        onConfirm: jest.fn(),
      });
    });
    const del = await screen.findByText('Delete');
    const keep = screen.getByText('Keep');
    // destructive action → destructive color; cancel → tint. They must differ.
    expect(flatColor(del)).toBe(tokens.color.destructive);
    expect(flatColor(keep)).toBe(tokens.color.tint);
    expect(flatColor(del)).not.toBe(flatColor(keep));
    // cancel weight is lighter (400) than a non-cancel button (600).
    expect(StyleSheet.flatten(keep.props.style)?.fontWeight).toBe('400');
    expect(StyleSheet.flatten(del.props.style)?.fontWeight).toBe('600');
  });

  it('promotes the queued dialog when a button handler opens another', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      // First dialog's confirm enqueues a second one (the store's FIFO queue case).
      showConfirm({
        title: 'Step 1',
        confirmText: 'Next',
        onConfirm: () => showAlert({ title: 'Step 2 done' }),
      });
    });
    fireEvent.press(await screen.findByText('Next'));
    // Step 1 gone, Step 2 promoted from the queue and now on screen.
    expect(await screen.findByText('Step 2 done')).toBeTruthy();
    expect(screen.queryByText('Step 1')).toBeNull();
    expect(useDialogStore.getState().current?.title).toBe('Step 2 done');
  });

  it('hardware back on a confirm runs the CANCEL button, never the action', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      // Cancel is FIRST and the destructive action is LAST, so a fallback that just took
      // buttons[last] would run the delete — this is what pins `buttons.find(cancel)`.
      showConfirm({
        title: 'Delete forever?',
        confirmText: 'Delete',
        destructive: true,
        onConfirm,
        onCancel,
      });
    });
    await screen.findByText('Delete forever?');

    pressHardwareBack();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Delete forever?')).toBeNull());
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('hardware back on a single-DESTRUCTIVE-button dialog DISMISSES without deleting', async () => {
    // Back means "get me out of here" — it must never be read as consent to delete.
    // `onRequestClose` still falls back to the LAST button when no button has style 'cancel' (so a
    // one-button informational dialog runs its acknowledge handler), but a 'destructive' button is
    // now never auto-pressed. Before that guard, BACK on this dialog EXECUTED the deletion. No
    // shipped call site was shaped like this — every destructive dialog in src/ + app/ pairs the
    // action with a 'cancel' button — so it was a defect-in-waiting the first cancel-less
    // destructive dialog would have triggered.
    const onDelete = jest.fn();
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showDialog('Delete account?', undefined, [
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]);
    });
    await screen.findByText('Delete account?');

    pressHardwareBack();

    expect(onDelete).not.toHaveBeenCalled();
    // ...but the dialog still closes, so the user is not trapped.
    await waitFor(() => expect(screen.queryByText('Delete account?')).toBeNull());
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('hardware back still runs a non-destructive lone button (informational acknowledge)', async () => {
    // Guards the narrowness of the fix: only DESTRUCTIVE is skipped, not every lone button.
    const onOk = jest.fn();
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showDialog('Heads up', 'Sync finished', [{ text: 'OK', onPress: onOk }]);
    });
    await screen.findByText('Heads up');

    pressHardwareBack();

    expect(onOk).toHaveBeenCalledTimes(1);
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('renders 2 buttons for a confirm (side-by-side row) with the given labels', async () => {
    await renderWithTheme(<AppDialog />);
    await act(async () => {
      showConfirm({ title: 'Two buttons', onConfirm: jest.fn() });
    });
    await screen.findByText('Two buttons');
    // Default labels from showConfirm: Cancel + OK.
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByText('OK')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
