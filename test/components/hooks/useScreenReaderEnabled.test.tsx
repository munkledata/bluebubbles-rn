import { AccessibilityInfo } from 'react-native';
import { act, renderHook } from '../support/renderWithTheme';
import { useScreenReaderEnabled } from '@ui/hooks/useScreenReaderEnabled';

type Listener = (enabled: boolean) => void;

const mockIsScreenReaderEnabled = AccessibilityInfo.isScreenReaderEnabled as jest.Mock;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let listeners: Listener[];
let removed: jest.Mock;

beforeEach(() => {
  listeners = [];
  removed = jest.fn();
  mockAddEventListener.mockImplementation((_event: string, listener: Listener) => {
    listeners.push(listener);
    return { remove: removed };
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useScreenReaderEnabled', () => {
  it('reports the first answer, then follows changes', async () => {
    mockIsScreenReaderEnabled.mockResolvedValue(true);
    const { result } = await renderHook(() => useScreenReaderEnabled());
    expect(result.current).toBe(true);
    expect(mockAddEventListener).toHaveBeenCalledWith('screenReaderChanged', expect.any(Function));

    await act(async () => listeners[0]?.(false));
    expect(result.current).toBe(false);
  });

  it('never lets a slower first answer undo a newer change', async () => {
    const query = deferred<boolean>();
    mockIsScreenReaderEnabled.mockReturnValue(query.promise);
    const { result } = await renderHook(() => useScreenReaderEnabled());
    await act(async () => listeners[0]?.(true));
    await act(async () => {
      query.resolve(false);
      await query.promise;
    });
    expect(result.current).toBe(true);
  });

  it('stops listening when unmounted', async () => {
    mockIsScreenReaderEnabled.mockResolvedValue(false);
    const { unmount } = await renderHook(() => useScreenReaderEnabled());
    await unmount();
    expect(removed).toHaveBeenCalledTimes(1);
  });
});
