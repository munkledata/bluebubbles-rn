import { useShareIntentStore } from '@state/shareIntentStore';

beforeEach(() => useShareIntentStore.getState().clear());

describe('shareIntentStore', () => {
  it('holds shared text + files, then clears (the new-chat handoff contract)', () => {
    useShareIntentStore.getState().set({
      text: 'shared note',
      files: [{ uri: 'file://a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
    });
    expect(useShareIntentStore.getState().text).toBe('shared note');
    expect(useShareIntentStore.getState().files).toHaveLength(1);

    useShareIntentStore.getState().clear();
    expect(useShareIntentStore.getState().text).toBeNull();
    expect(useShareIntentStore.getState().files).toEqual([]);
  });
});
