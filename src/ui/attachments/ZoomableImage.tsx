import { Image } from 'expo-image';
import React, { useEffect, useRef } from 'react';
import { Animated, type GestureResponderEvent, PanResponder, StyleSheet, View } from 'react-native';
import { useReduceMotionPreferenceRef } from '../hooks/useReduceMotionPreference';

const MAX_SCALE = 4;

interface ZoomableImageProps {
  uri: string | null;
  blurhash?: string | null;
  width: number;
  height: number;
  /** False when this page isn't the visible one → reset any zoom (page changed). */
  active?: boolean;
  /** Reports whether the image is currently zoomed (>1x) so the pager can disable paging. */
  onZoomChange?: (zoomed: boolean) => void;
  /** Local decode/read failure; fullscreen recovery decides whether to offer copy-on-write retry. */
  onError?: () => void;
}

/** Distance between the first two active touches (for pinch). */
function touchDistance(e: GestureResponderEvent): number {
  const t = e.nativeEvent.touches;
  if (t.length < 2) return 0;
  return Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Pinch-to-zoom + pan-while-zoomed image, built on RN's own `PanResponder` + `Animated` —
 * deliberately NOT gesture-handler/Reanimated (this project ships gestures on the RN `Animated`
 * API only; see `SwipeableRow`). The old app's `ScrollView maximumZoomScale` was iOS-only and a
 * no-op on Android, so fullscreen photos couldn't be zoomed at all on the target platform.
 *
 * Gestures: two fingers pinch to scale (1–4×); one finger pans ONLY while zoomed (so a one-finger
 * swipe at 1× falls through to the parent pager to change photos). Releasing below ~1× returns to
 * fit with the existing spring, or snaps immediately while Reduce Motion is unresolved/enabled.
 * Double-tap-to-zoom is intentionally omitted (a nicety, not the core fix).
 *
 * NOTE: gesture feel needs on-device verification (jest can't exercise native touches).
 */
export function ZoomableImage({
  uri,
  blurhash,
  width,
  height,
  active = true,
  onZoomChange,
  onError,
}: ZoomableImageProps): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // Committed (post-release) values + live gesture state (refs so the responder closure reads
  // the latest without re-creating the PanResponder).
  const committedScale = useRef(1);
  const committedTranslate = useRef({ x: 0, y: 0 });
  const liveScale = useRef(1);
  const liveTranslate = useRef({ x: 0, y: 0 });
  const initialDist = useRef(0);
  const zoomedRef = useRef(false);
  const activeReset = useRef<Animated.CompositeAnimation | null>(null);

  const setZoomed = (z: boolean): void => {
    if (zoomedRef.current === z) return;
    zoomedRef.current = z;
    onZoomChange?.(z);
  };

  const stopActiveReset = (): boolean => {
    const animation = activeReset.current;
    activeReset.current = null;
    animation?.stop();
    return animation != null;
  };

  const snapAnimatedValuesToFit = (): void => {
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
  };

  // Turning Reduce Motion on mid-reset stops the spring and snaps to fit.
  const reduceMotion = useReduceMotionPreferenceRef((enabled) => {
    if (enabled && stopActiveReset()) snapAnimatedValuesToFit();
  });

  const resetZoom = (animated: boolean): void => {
    stopActiveReset();
    committedScale.current = 1;
    committedTranslate.current = { x: 0, y: 0 };
    liveScale.current = 1;
    liveTranslate.current = { x: 0, y: 0 };
    initialDist.current = 0;
    if (animated && reduceMotion.current === false) {
      const animation = Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
      ]);
      activeReset.current = animation;
      animation.start(() => {
        if (activeReset.current === animation) activeReset.current = null;
      });
    } else {
      snapAnimatedValuesToFit();
    }
    setZoomed(false);
  };

  useEffect(
    () => () => {
      stopActiveReset();
    },
    [],
  );

  // Reset when this page scrolls out of view so returning to it starts at fit.
  useEffect(() => {
    if (!active) resetZoom(false);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const responder = useRef(
    PanResponder.create({
      // Don't claim on touch-start: a tap/single-swipe at 1× must reach the parent pager.
      onStartShouldSetPanResponder: () => false,
      // Claim two-finger pinches always; one-finger moves only while zoomed (→ pan). A one-finger
      // swipe at 1× is left to the pager to change photos.
      onMoveShouldSetPanResponder: (e) =>
        e.nativeEvent.touches.length === 2 || committedScale.current > 1.01,
      onPanResponderGrant: (e) => {
        stopActiveReset();
        initialDist.current = touchDistance(e);
        liveScale.current = committedScale.current;
        liveTranslate.current = { ...committedTranslate.current };
      },
      onPanResponderMove: (e, g) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) {
          const d = touchDistance(e);
          if (initialDist.current === 0) {
            initialDist.current = d;
            return;
          }
          const next = clamp((committedScale.current * d) / initialDist.current, 1, MAX_SCALE);
          liveScale.current = next;
          scale.setValue(next);
          setZoomed(next > 1.01);
        } else if (touches.length === 1 && committedScale.current > 1.01) {
          // Pan, clamped so the image can't be dragged entirely off-screen.
          const maxX = ((liveScale.current - 1) * width) / 2;
          const maxY = ((liveScale.current - 1) * height) / 2;
          const x = clamp(committedTranslate.current.x + g.dx, -maxX, maxX);
          const y = clamp(committedTranslate.current.y + g.dy, -maxY, maxY);
          liveTranslate.current = { x, y };
          translateX.setValue(x);
          translateY.setValue(y);
        }
      },
      onPanResponderRelease: () => {
        if (liveScale.current <= 1.01) {
          resetZoom(true);
          return;
        }
        committedScale.current = liveScale.current;
        committedTranslate.current = { ...liveTranslate.current };
        initialDist.current = 0;
        setZoomed(true);
      },
      onPanResponderTerminate: () => {
        // Commit whatever we have so a stolen responder doesn't strand a half-applied gesture.
        if (liveScale.current <= 1.01) resetZoom(true);
        else {
          committedScale.current = liveScale.current;
          committedTranslate.current = { ...liveTranslate.current };
        }
      },
    }),
  ).current;

  return (
    <View style={[styles.page, { width, height }]} {...responder.panHandlers}>
      {uri ? (
        <Animated.View style={{ transform: [{ scale }, { translateX }, { translateY }] }}>
          <Image
            source={{ uri }}
            placeholder={blurhash ? { blurhash } : null}
            contentFit="contain"
            style={{ width, height }}
            accessibilityIgnoresInvertColors
            onError={onError}
          />
        </Animated.View>
      ) : (
        // No confirmed file for this page: a neighbour not checked yet, a page being checked, or
        // media that is not downloaded. The viewer's overlay says which, so no label here; a
        // "Not downloaded" label was false for photos already on the device.
        <View style={[styles.placeholder, { width, height }]}>
          {blurhash ? (
            <Image
              placeholder={{ blurhash }}
              contentFit="cover"
              style={StyleSheet.absoluteFill}
              accessibilityIgnoresInvertColors
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
});
