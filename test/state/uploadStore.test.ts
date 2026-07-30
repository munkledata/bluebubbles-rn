import { uploadStoreSink, useUploadStore } from '@state/uploadStore';

const INFO = { chatGuid: 'c1', name: 'photo.jpg', total: 1000 };
const entries = () => useUploadStore.getState().byGuid;

beforeEach(() => {
  useUploadStore.setState({ byGuid: {} });
});

describe('useUploadStore', () => {
  it('opens an entry at zero bytes with the size it was told up front', () => {
    useUploadStore.getState().start('att-1', INFO);
    expect(entries()['att-1']).toMatchObject({
      chatGuid: 'c1',
      name: 'photo.jpg',
      sent: 0,
      total: 1000,
    });
  });

  it('treats an unknown up-front size as 0 (indeterminate) rather than storing junk', () => {
    useUploadStore.getState().start('att-1', { ...INFO, total: -1 });
    expect(entries()['att-1']?.total).toBe(0);
  });

  it('records byte progress', () => {
    useUploadStore.getState().start('att-1', INFO);
    useUploadStore.getState().progress('att-1', 400, 1000);
    expect(entries()['att-1']).toMatchObject({ sent: 400, total: 1000 });
  });

  it('learns the real total from the first progress event when it was unknown', () => {
    useUploadStore.getState().start('memo', { chatGuid: 'c1', name: 'voice.m4a', total: 0 });
    useUploadStore.getState().progress('memo', 100, 8000);
    expect(entries()['memo']).toMatchObject({ sent: 100, total: 8000 });
  });

  it('keeps the last known total when the native layer reports an unknown one', () => {
    // -1 is how the native side spells "no content length". Overwriting a real total with it
    // would knock a determinate bar back to a spinner mid-upload.
    useUploadStore.getState().start('att-1', INFO);
    useUploadStore.getState().progress('att-1', 400, 1000);
    useUploadStore.getState().progress('att-1', 600, -1);
    expect(entries()['att-1']).toMatchObject({ sent: 600, total: 1000 });
  });

  it('REMOVES the entry on settle, so nothing is left drawing a spinner', () => {
    useUploadStore.getState().start('att-1', INFO);
    useUploadStore.getState().settle('att-1');
    expect(entries()['att-1']).toBeUndefined();
    expect(Object.keys(entries())).toHaveLength(0);
  });

  it('does not resurrect a settled entry from a late progress event', () => {
    // Progress events come from native and can land after the upload promise resolves. A
    // resurrected entry has nothing left to settle it, so the phantom spinner would be forever.
    useUploadStore.getState().start('att-1', INFO);
    useUploadStore.getState().settle('att-1');
    useUploadStore.getState().progress('att-1', 900, 1000);
    expect(entries()['att-1']).toBeUndefined();
  });

  it('settling an unknown key is a no-op', () => {
    useUploadStore.getState().start('att-1', INFO);
    const before = entries();
    useUploadStore.getState().settle('nope');
    expect(entries()).toBe(before); // same object identity → no needless re-render
  });

  it('tracks concurrent uploads independently', () => {
    useUploadStore.getState().start('att-1', INFO);
    useUploadStore.getState().start('att-2', { ...INFO, name: 'clip.mp4', total: 5000 });
    useUploadStore.getState().progress('att-2', 2500, 5000);
    useUploadStore.getState().settle('att-1');

    expect(entries()['att-1']).toBeUndefined();
    expect(entries()['att-2']).toMatchObject({ sent: 2500, total: 5000, name: 'clip.mp4' });
  });
});

describe('uploadStoreSink', () => {
  it('drives the store — this is the wiring handed to runTrackedUpload', () => {
    uploadStoreSink.start('att-9', INFO);
    uploadStoreSink.progress('att-9', 250, 1000);
    expect(entries()['att-9']).toMatchObject({ sent: 250, total: 1000 });
    uploadStoreSink.settle('att-9');
    expect(entries()['att-9']).toBeUndefined();
  });
});
