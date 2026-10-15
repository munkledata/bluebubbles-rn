import React, { Suspense } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AttachmentRow } from '@db/repositories';
import { attachmentKind, isLocalFileUri } from '@utils';
import { LoadErrorBoundary } from '../LoadErrorBoundary';
import { ContactCard } from './ContactCard';
import { FileChip } from './FileChip';
import { ImageAttachment } from './ImageAttachment';
import { LocationCard } from './LocationCard';
import { useAttachmentCachePathProtection } from './useAttachmentCachePathProtection';
import { VideoPlayer } from './VideoPlayer';

// Lazy so `expo-audio` (a native module) is only pulled in when an audio attachment
// actually renders — and wrapped in LoadErrorBoundary because Suspense does NOT catch a
// REJECTED import (e.g. on a build that hasn't linked expo-audio); without the boundary a
// failed chunk would crash the whole app. Both Suspense (pending) and the boundary
// (rejected) fall back to the plain file chip.
const AudioAttachment = React.lazy(() =>
  import('./AudioAttachment').then((m) => ({ default: m.AudioAttachment })),
);

interface AttachmentViewProps {
  att: AttachmentRow;
  isFromMe: boolean;
  showTail: boolean;
  onLongPress?: () => void;
}

/** Renders one attachment by MIME type (audio + unknown fall back to a file chip). */
export function AttachmentView({
  att,
  isFromMe,
  showTail,
  onLongPress,
}: AttachmentViewProps): React.JSX.Element {
  // Every mounted bubble kind may hand its local file to a native decoder/player/share action.
  // Pin once at the dispatcher so image, video, audio, contact, location, and document paths all
  // receive the same eviction safety without six subtly different copies of the lifecycle.
  const protectedPath = useAttachmentCachePathProtection(att.localPath);
  if (isLocalFileUri(att.localPath) && protectedPath !== att.localPath) {
    // Do not mount a leaf with a synthetic `localPath:null`: ImageAttachment would interpret that
    // transient value as undownloaded and could start an unnecessary auto-download before this
    // layout-effect gate settles. A refused path remains a neutral, non-reading placeholder, sized
    // like the bubble's minimum so a brief refusal does not collapse it.
    const kind = attachmentKind(att.mimeType);
    return (
      <View
        testID="attachment-pin-placeholder"
        style={kind === 'image' || kind === 'video' ? styles.mediaPlaceholder : styles.placeholder}
      />
    );
  }
  switch (attachmentKind(att.mimeType)) {
    case 'image':
      return (
        <ImageAttachment
          att={att}
          isFromMe={isFromMe}
          showTail={showTail}
          onLongPress={onLongPress}
        />
      );
    case 'video':
      return (
        <VideoPlayer att={att} isFromMe={isFromMe} showTail={showTail} onLongPress={onLongPress} />
      );
    case 'contact':
      return <ContactCard att={att} isFromMe={isFromMe} onLongPress={onLongPress} />;
    case 'location':
      return <LocationCard att={att} isFromMe={isFromMe} onLongPress={onLongPress} />;
    case 'audio': {
      const fileChip = <FileChip att={att} isFromMe={isFromMe} onLongPress={onLongPress} />;
      return (
        <LoadErrorBoundary fallback={fileChip}>
          <Suspense fallback={fileChip}>
            <AudioAttachment att={att} isFromMe={isFromMe} onLongPress={onLongPress} />
          </Suspense>
        </LoadErrorBoundary>
      );
    }
    default:
      return <FileChip att={att} isFromMe={isFromMe} onLongPress={onLongPress} />;
  }
}

const styles = StyleSheet.create({
  // ImageAttachment's own minimum size; chips and cards are at least one row tall.
  mediaPlaceholder: { minWidth: 120, minHeight: 80 },
  placeholder: { minHeight: 44 },
});
