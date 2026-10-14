import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useWindowDimensions } from 'react-native';
import { isLocalFileUri } from '@utils';
import { useAttachmentCachePathProtection } from './useAttachmentCachePathProtection';
import { ZoomableImage } from './ZoomableImage';

/** FlatList mounts adjacent carousel pages too; every mounted native image owns a distinct pin. */
export function ProtectedZoomableImage({
  uri,
  blurhash,
  width,
  height,
  active,
  protectionEpoch,
  onError,
  onZoomChange,
}: {
  uri: string | null;
  blurhash: string | null;
  width: number;
  height: number;
  active: boolean;
  protectionEpoch: number;
  onError: () => void;
  onZoomChange: (zoomed: boolean) => void;
}): React.JSX.Element {
  const protectedUri = useAttachmentCachePathProtection(uri, protectionEpoch);
  return (
    <ZoomableImage
      uri={isLocalFileUri(protectedUri) ? protectedUri : null}
      blurhash={blurhash}
      width={width}
      height={height}
      active={active}
      onError={onError}
      onZoomChange={onZoomChange}
    />
  );
}

/** Do not construct expo-video's native player until the cache path has a live reader pin. */
export function ProtectedFullscreenVideo({
  uri,
  protectionEpoch,
  onError,
}: {
  uri: string;
  protectionEpoch: number;
  onError: () => void;
}): React.JSX.Element | null {
  const protectedUri = useAttachmentCachePathProtection(uri, protectionEpoch);
  return isLocalFileUri(protectedUri) ? (
    <FullscreenVideo uri={protectedUri} onError={onError} />
  ) : null;
}

/** Fullscreen native video with controls; autoplays on mount. useVideoPlayer auto-releases
 *  on unmount, so no manual cleanup is needed (this screen owns the player for its lifetime). */
function FullscreenVideo({
  uri,
  onError,
}: {
  uri: string;
  onError: () => void;
}): React.JSX.Element {
  const win = useWindowDimensions();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') onError();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: win.width, height: win.height }}
    />
  );
}
