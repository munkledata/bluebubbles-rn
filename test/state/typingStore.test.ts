import { useTypingStore } from '@state/typingStore';

describe('typingStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useTypingStore.setState({ typing: {} });
  });
  afterEach(() => jest.useRealTimers());

  it('sets typing on display=true and clears on display=false', () => {
    useTypingStore.getState().setTyping('c1', true);
    expect(useTypingStore.getState().typing.c1).toBe(true);
    useTypingStore.getState().setTyping('c1', false);
    expect(useTypingStore.getState().typing.c1).toBe(false);
  });

  it('auto-clears after the TTL when no stop event arrives', () => {
    useTypingStore.getState().setTyping('c1', true);
    jest.advanceTimersByTime(12_000);
    expect(useTypingStore.getState().typing.c1).toBe(false);
  });

  it('a fresh typing event resets the auto-clear timer', () => {
    useTypingStore.getState().setTyping('c1', true);
    jest.advanceTimersByTime(8_000);
    useTypingStore.getState().setTyping('c1', true); // keystroke → reset
    jest.advanceTimersByTime(8_000); // 16s elapsed, but only 8s since the reset
    expect(useTypingStore.getState().typing.c1).toBe(true);
    jest.advanceTimersByTime(5_000);
    expect(useTypingStore.getState().typing.c1).toBe(false);
  });

  it('tracks chats independently', () => {
    useTypingStore.getState().setTyping('c1', true);
    useTypingStore.getState().setTyping('c2', true);
    useTypingStore.getState().setTyping('c1', false);
    expect(useTypingStore.getState().typing.c1).toBe(false);
    expect(useTypingStore.getState().typing.c2).toBe(true);
  });
});
