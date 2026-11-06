/**
 * LivePhotoControl: the LIVE pill on a Live Photo page. Hold plays the clip over the still, release
 * stops it, a tap plays it once; the clip comes from the bounded clip downloader (mocked here).
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

type Listener = (payload: unknown) => void;
const mockPlayers: { listeners: Map<string, Listener[]>; play: jest.Mock }[] = [];

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn((_uri: string, setup?: (p: unknown) => void) => {
    const listeners = new Map<string, Listener[]>();
    const player = {
      loop: true,
      play: jest.fn(),
      pause: jest.fn(),
      addListener: jest.fn((event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return { remove: jest.fn() };
      }),
    };
    // The mock makes a new player per render; useEventListener re-subscribes to the latest one.
    mockPlayers.push({ listeners, play: player.play });
    setup?.(player);
    return player;
  }),
  VideoView: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require('react-native');
    return <View testID="video-view" />;
  },
}));

const mockLoad = jest.fn<Promise<string | null>, [string, boolean?]>();
jest.mock('@/services/download/livePhotoClips', () => ({
  loadLivePhotoClip: (guid: string, replace?: boolean) => mockLoad(guid, replace),
}));

// eslint-disable-next-line import/first
import { LIVE_PHOTO_TAP_MS, LivePhotoControl } from '@ui/attachments/LivePhotoControl';

const TEST_METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, right: 0, bottom: 24, left: 0 },
};
const CLIP = 'file:///doc/live-photo-clips/generation-1/media-still-1.mov';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let now = 1_000;
beforeEach(() => {
  mockLoad.mockReset();
  mockPlayers.length = 0;
  now = 1_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function renderControl(isCurrent: () => boolean = () => true) {
  await render(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <LivePhotoControl guid="still-1" width={400} height={800} isCurrent={isCurrent} />
    </SafeAreaProvider>,
  );
  return screen.getByRole('button', { name: 'Play Live Photo' });
}

function lastPlayerEmit(event: string, payload?: unknown): void {
  const player = mockPlayers.at(-1);
  for (const listener of player?.listeners.get(event) ?? []) listener(payload);
}

describe('LivePhotoControl', () => {
  it('plays the clip while held and stops on release', async () => {
    mockLoad.mockResolvedValue(CLIP);
    const pill = await renderControl();
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();

    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    expect(mockLoad).toHaveBeenCalledWith('still-1', false);
    expect(screen.getByTestId('live-photo-clip')).toBeTruthy();
    expect(mockPlayers.at(-1)?.play).toHaveBeenCalled();

    now += LIVE_PHOTO_TAP_MS + 500;
    await act(async () => {
      fireEvent(pill, 'pressOut');
    });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();

    // A second hold reuses the clip it already has.
    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('live-photo-clip')).toBeTruthy();
  });

  it('a tap plays the clip once, even when it arrives after the finger lifted', async () => {
    const pending = deferred<string | null>();
    mockLoad.mockReturnValue(pending.promise);
    const pill = await renderControl();

    await act(async () => {
      fireEvent(pill, 'pressIn');
      fireEvent(pill, 'pressOut');
    });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();
    expect(pill.props.accessibilityState).toMatchObject({ busy: true });

    await act(async () => {
      pending.resolve(CLIP);
    });
    expect(screen.getByTestId('live-photo-clip')).toBeTruthy();

    await act(async () => {
      lastPlayerEmit('playToEnd');
    });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();
  });

  it('a still with no clip turns the pill off', async () => {
    mockLoad.mockResolvedValue(null);
    const pill = await renderControl();
    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    const off = screen.getByRole('button', { name: 'Live Photo unavailable' });
    expect(off.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();
  });

  it('drops an answer that arrives after the account changed, and asks nothing once it has', async () => {
    let current = true;
    const pending = deferred<string | null>();
    mockLoad.mockReturnValue(pending.promise);
    const pill = await renderControl(() => current);
    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    current = false;
    await act(async () => {
      pending.resolve(CLIP);
    });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();

    mockLoad.mockClear();
    await act(async () => {
      fireEvent(pill, 'pressOut');
      fireEvent(pill, 'pressIn');
    });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('a clip that fails to play is fetched again, replacing the saved file', async () => {
    mockLoad.mockResolvedValue(CLIP);
    const pill = await renderControl();
    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    await act(async () => {
      lastPlayerEmit('statusChange', { status: 'error' });
    });
    expect(screen.queryByTestId('live-photo-clip')).toBeNull();

    now += LIVE_PHOTO_TAP_MS + 500;
    await act(async () => {
      fireEvent(pill, 'pressOut');
      fireEvent(pill, 'pressIn');
    });
    expect(mockLoad).toHaveBeenLastCalledWith('still-1', true);
  });
});
