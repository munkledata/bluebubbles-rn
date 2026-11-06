import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadLivePhotoClip } from '@/services/download/livePhotoClips';

/** A press shorter than this is a tap: the clip plays once to its end instead of while held. */
export const LIVE_PHOTO_TAP_MS = 300;

type Playback = 'idle' | 'held' | 'once';

/**
 * The LIVE pill on a Live Photo page of the media viewer. Hold it to play the motion clip over the
 * still and let go to stop; a tap (or a screen-reader double tap) plays it once. The clip is
 * fetched on the first press through the bounded clip downloader and then reused. A pill rather
 * than a hold on the photo, because the photo's own pinch/pan responder owns touches there.
 *
 * Mount one per still (key it by guid). `isCurrent` is the screen's account lease: an answer that
 * arrives after the account changed, or after this pill went away, is dropped.
 */
export function LivePhotoControl({
  guid,
  width,
  height,
  isCurrent,
}: {
  guid: string;
  width: number;
  height: number;
  isCurrent: () => boolean;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [playback, setPlayback] = useState<Playback>('idle');
  const mounted = useRef(true);
  const pressStartedAt = useRef(0);
  const replaceNext = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchClip = (): void => {
    if (uri || loading || unavailable || !isCurrent()) return;
    setLoading(true);
    const replace = replaceNext.current;
    replaceNext.current = false;
    void loadLivePhotoClip(guid, replace).then((clip) => {
      if (!mounted.current || !isCurrent()) return;
      setLoading(false);
      if (clip) setUri(clip);
      else {
        setUnavailable(true);
        setPlayback('idle');
      }
    });
  };

  const showing = uri !== null && playback !== 'idle';

  return (
    <>
      {showing ? (
        <LivePhotoClipPlayer
          uri={uri}
          width={width}
          height={height}
          onEnd={() => setPlayback('idle')}
          onError={() => {
            // The saved file could not be played: drop it, and fetch it again on the next press.
            replaceNext.current = true;
            setUri(null);
            setPlayback('idle');
          }}
        />
      ) : null}
      <View style={[styles.wrap, { bottom: insets.bottom + 24 }]} pointerEvents="box-none">
        <Pressable
          onPressIn={() => {
            pressStartedAt.current = Date.now();
            setPlayback('held');
            fetchClip();
          }}
          onPressOut={() => {
            const tapped = Date.now() - pressStartedAt.current < LIVE_PHOTO_TAP_MS;
            setPlayback(tapped ? 'once' : 'idle');
          }}
          disabled={unavailable}
          hitSlop={12}
          style={[styles.pill, unavailable && styles.disabled]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={unavailable ? 'Live Photo unavailable' : 'Play Live Photo'}
          accessibilityHint={
            unavailable ? undefined : 'Hold to play the motion; tap to play it once'
          }
          accessibilityState={{ disabled: unavailable, busy: loading }}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.label}>◉ LIVE</Text>
          )}
        </Pressable>
      </View>
    </>
  );
}

/** The clip over the still, playing from the start with sound; ends on its last frame or release. */
function LivePhotoClipPlayer({
  uri,
  width,
  height,
  onEnd,
  onError,
}: {
  uri: string;
  width: number;
  height: number;
  onEnd: () => void;
  onError: () => void;
}): React.JSX.Element {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  useEventListener(player, 'playToEnd', onEnd);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') onError();
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="live-photo-clip">
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        style={{ width, height }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    minHeight: 36,
    minWidth: 76,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  disabled: { opacity: 0.45 },
  label: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
});
