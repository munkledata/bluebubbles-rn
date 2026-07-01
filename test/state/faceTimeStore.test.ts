import { useFaceTimeStore } from '@state/faceTimeStore';

describe('faceTimeStore', () => {
  beforeEach(() => useFaceTimeStore.setState({ call: null, incoming: null }));

  it('starts with no active call', () => {
    expect(useFaceTimeStore.getState().call).toBeNull();
  });

  it('open() sets the active call and close() clears it', () => {
    const call = {
      link: 'https://facetime.apple.com/join#x',
      chatGuid: 'iMessage;-;+1555',
      video: true,
    };
    useFaceTimeStore.getState().open(call);
    expect(useFaceTimeStore.getState().call).toEqual(call);
    useFaceTimeStore.getState().close();
    expect(useFaceTimeStore.getState().call).toBeNull();
  });

  it('open() replaces a prior call (single active call)', () => {
    useFaceTimeStore.getState().open({ link: 'facetime://a', chatGuid: 'a', video: false });
    useFaceTimeStore.getState().open({ link: 'facetime://b', chatGuid: 'b', video: true });
    expect(useFaceTimeStore.getState().call?.chatGuid).toBe('b');
  });

  it('ring() sets an incoming call and dismissIncoming() clears the matching uuid', () => {
    useFaceTimeStore.getState().ring({ uuid: 'a', callerName: 'Alice', isAudio: false });
    expect(useFaceTimeStore.getState().incoming?.uuid).toBe('a');
    useFaceTimeStore.getState().dismissIncoming('a');
    expect(useFaceTimeStore.getState().incoming).toBeNull();
  });

  it('dismissIncoming() ignores a stale uuid (a late "ended" cannot clear a fresh ring)', () => {
    useFaceTimeStore.getState().ring({ uuid: 'a', callerName: 'Alice', isAudio: false });
    useFaceTimeStore.getState().dismissIncoming('b'); // ended for a different/older call
    expect(useFaceTimeStore.getState().incoming?.uuid).toBe('a');
  });

  it('incoming and call are independent slices', () => {
    useFaceTimeStore.getState().ring({ uuid: 'a', callerName: 'Alice', isAudio: true });
    useFaceTimeStore.getState().open({ link: 'facetime://a', chatGuid: '', video: false });
    // ring is not auto-cleared by open(); the overlay hides on activeCall, not the store.
    expect(useFaceTimeStore.getState().incoming?.uuid).toBe('a');
    expect(useFaceTimeStore.getState().call?.link).toBe('facetime://a');
  });
});
