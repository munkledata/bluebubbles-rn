/**
 * ZoomableImage (src/ui/attachments/ZoomableImage.tsx): pinch-to-zoom + pan-while-zoomed built on
 * RN's PanResponder + Animated. Real native drags can't be simulated in RNTL (same constraint as
 * swipeableRow.test.tsx), so this suite CAPTURES the PanResponder config via a `create` spy and
 * drives the gesture callbacks directly with synthetic touch events — the zoom state machine
 * (claim rules, pinch math, pan clamping, spring-back, terminate commit, page-change reset) is
 * pure JS over refs, so it is fully exercisable this way. `onZoomChange` is the observable output.
 *
 * In-file mock: `expo-image` (marker View forwarding source/placeholder, mirrors
 * imageAttachment.test.tsx).
 */
import React from 'react';
import {
  PanResponder,
  type GestureResponderEvent,
  type PanResponderCallbacks,
  type PanResponderInstance,
  type PanResponderGestureState,
} from 'react-native';
import { renderWithTheme, screen, act } from '../support/renderWithTheme';

jest.mock('expo-image', () => {
  const RN = require('react-native');
  const r = require('react');
  return {
    Image: (props: Record<string, unknown>) =>
      r.createElement(RN.View, {
        testID: 'expo-image',
        source: props.source,
        placeholder: props.placeholder,
      }),
  };
});

// eslint-disable-next-line import/first
import { ZoomableImage } from '@ui/attachments/ZoomableImage';

const WIDTH = 300;
const HEIGHT = 600;

/** Synthetic responder event carrying only what the component reads (touches). */
function evt(touches: Array<{ pageX: number; pageY: number }>): GestureResponderEvent {
  return { nativeEvent: { touches } } as unknown as GestureResponderEvent;
}

/** Two touches `dist` apart along x. */
function pinch(dist: number): GestureResponderEvent {
  return evt([
    { pageX: 0, pageY: 0 },
    { pageX: dist, pageY: 0 },
  ]);
}

const ONE_TOUCH = evt([{ pageX: 10, pageY: 10 }]);
const NO_TOUCH = evt([]);

function gst(dx = 0, dy = 0): PanResponderGestureState {
  return { dx, dy } as PanResponderGestureState;
}

describe('ZoomableImage', () => {
  let config: PanResponderCallbacks | undefined;

  beforeEach(() => {
    config = undefined;
    jest.spyOn(PanResponder, 'create').mockImplementation((c) => {
      config = c;
      return { panHandlers: {} } as PanResponderInstance;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The captured responder config, with every callback the component installs required. */
  function cfg(): Required<PanResponderCallbacks> {
    if (!config) throw new Error('PanResponder.create was not called');
    return config as Required<PanResponderCallbacks>;
  }

  /** Run a gesture callback inside act() — Animated setValue schedules React updates. */
  async function drive(fn: () => void): Promise<void> {
    await act(async () => {
      fn();
    });
  }

  async function mount(over: Partial<React.ComponentProps<typeof ZoomableImage>> = {}) {
    return renderWithTheme(
      <ZoomableImage uri="file:///photo.jpg" width={WIDTH} height={HEIGHT} {...over} />,
    );
  }

  it('renders the image when a uri is present', async () => {
    await mount();
    const img = screen.getByTestId('expo-image');
    expect(img.props.source).toEqual({ uri: 'file:///photo.jpg' });
  });

  it('renders the blurhash placeholder + hint when not downloaded', async () => {
    await mount({ uri: null, blurhash: 'LKO2?U%2Tw=w' });
    expect(screen.getByText('Not downloaded')).toBeTruthy();
    expect(screen.getByTestId('expo-image').props.placeholder).toEqual({
      blurhash: 'LKO2?U%2Tw=w',
    });
  });

  it('renders only the hint when not downloaded and no blurhash exists', async () => {
    await mount({ uri: null });
    expect(screen.getByText('Not downloaded')).toBeTruthy();
    expect(screen.queryByTestId('expo-image')).toBeNull();
  });

  it('never claims on touch-start and only claims moves for pinches while at 1x', async () => {
    await mount();
    expect(cfg().onStartShouldSetPanResponder(NO_TOUCH, gst())).toBe(false);
    expect(cfg().onMoveShouldSetPanResponder(pinch(100), gst())).toBe(true);
    // One-finger swipe at 1x falls through to the parent pager.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('pinching out zooms in, reports zoomed, and claims one-finger moves after release', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });

    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst())); // 2x
    expect(onZoomChange).toHaveBeenCalledWith(true);

    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenCalledTimes(1); // commit does not re-report

    // Zoomed → a one-finger move is now a pan claim.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
  });

  it('caps the pinch at 4x', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(10), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(1000), gst())); // raw 100x → clamped 4x
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenCalledWith(true);
    // Pinch back down from the committed 4x by the same ratio → still >1 → stays zoomed.
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(50), gst())); // 4x * 0.5 = 2x
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).not.toHaveBeenCalledWith(false);
  });

  it('adopts the first two-finger distance mid-gesture when the grant saw fewer touches', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(ONE_TOUCH, gst())); // touchDistance → 0
    await drive(() => cfg().onPanResponderMove(pinch(100), gst())); // seeds initialDist, no scale yet
    expect(onZoomChange).not.toHaveBeenCalled();
    await drive(() => cfg().onPanResponderMove(pinch(300), gst())); // now a real 3x pinch
    expect(onZoomChange).toHaveBeenCalledWith(true);
  });

  it('pans with one finger while zoomed without throwing or re-reporting zoom', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    onZoomChange.mockClear();

    await drive(() => cfg().onPanResponderGrant(ONE_TOUCH, gst()));
    // Far beyond the clamp bounds ((scale-1)*size/2) in both axes.
    await drive(() => cfg().onPanResponderMove(ONE_TOUCH, gst(10_000, -10_000)));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).not.toHaveBeenCalled(); // still zoomed; no state flip
  });

  it('springs back to fit when released at ~1x', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenLastCalledWith(true);

    // Pinch back below the zoom threshold and release.
    await drive(() => cfg().onPanResponderGrant(pinch(200), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(90), gst())); // 2x * 0.45 → clamped to 1
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('commits the live zoom when the responder is terminated mid-gesture', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(300), gst())); // 3x live
    await drive(() => cfg().onPanResponderTerminate(NO_TOUCH, gst()));
    // Committed → a later one-finger move is claimed as a pan.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
  });

  it('resets to fit when terminated at ~1x', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(101), gst())); // ~1x
    await drive(() => cfg().onPanResponderTerminate(NO_TOUCH, gst()));
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('resets the zoom when the page becomes inactive', async () => {
    const onZoomChange = jest.fn();
    const view = await mount({ onZoomChange, active: true });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      view.rerender(
        <ZoomableImage
          uri="file:///photo.jpg"
          width={WIDTH}
          height={HEIGHT}
          active={false}
          onZoomChange={onZoomChange}
        />,
      );
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });
});
