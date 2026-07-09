import {
  showAlert,
  showConfirm,
  showDialog,
  useDialogStore,
} from '@ui/dialog/dialogStore';

beforeEach(() => {
  useDialogStore.setState({ current: null, queue: [] });
});

describe('dialog store', () => {
  it('showDialog makes the request current', () => {
    showDialog('Title', 'Body');
    const { current } = useDialogStore.getState();
    expect(current?.title).toBe('Title');
    expect(current?.message).toBe('Body');
    // No buttons given → a single default OK.
    expect(current?.buttons).toEqual([{ text: 'OK', style: 'default' }]);
  });

  it('queues a second dialog behind the first, then promotes it on dismiss', () => {
    showDialog('First');
    showDialog('Second');
    expect(useDialogStore.getState().current?.title).toBe('First');
    expect(useDialogStore.getState().queue).toHaveLength(1);

    useDialogStore.getState().dismiss();
    expect(useDialogStore.getState().current?.title).toBe('Second');
    expect(useDialogStore.getState().queue).toHaveLength(0);

    useDialogStore.getState().dismiss();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('showConfirm builds a Cancel + action pair with the right styles', () => {
    const onConfirm = jest.fn();
    showConfirm({ title: 'Delete?', confirmText: 'Delete', destructive: true, onConfirm });
    const btns = useDialogStore.getState().current!.buttons;
    expect(btns.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete', 'destructive'],
    ]);
    btns[1]!.onPress?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('showAlert builds a single default button', () => {
    showAlert({ title: 'Heads up', message: 'Done' });
    const btns = useDialogStore.getState().current!.buttons;
    expect(btns).toHaveLength(1);
    expect(btns[0]!.style).toBe('default');
  });

  it('a dialog opened from a button handler survives via the queue', () => {
    // Simulates a confirm whose action then reports success (the "nested alert" case): while the
    // first is current, dismiss + enqueue in one flow leaves the second showing.
    showConfirm({
      title: 'Rotate key?',
      onConfirm: () => {
        useDialogStore.getState().dismiss();
        showAlert({ title: 'Done', message: 'Key rotated.' });
      },
    });
    const confirm = useDialogStore.getState().current!;
    confirm.buttons.find((b) => b.style !== 'cancel')!.onPress?.();
    expect(useDialogStore.getState().current?.title).toBe('Done');
  });
});
