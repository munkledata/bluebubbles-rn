import React, { Suspense } from 'react';
import type { AttachmentRow } from '@db/repositories';
import { attachmentKind } from '@utils';
import { LoadErrorBoundary } from '../LoadErrorBoundary';
import { ContactCard } from './ContactCard';
import { FileChip } from './FileChip';
import { ImageAttachment } from './ImageAttachment';
import { LocationCard } from './LocationCard';
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
}

/** Renders one attachment by MIME type (audio + unknown fall back to a file chip). */
export function AttachmentView({
  att,
  isFromMe,
  showTail,
}: AttachmentViewProps): React.JSX.Element {
  switch (attachmentKind(att.mimeType)) {
    case 'image':
      return <ImageAttachment att={att} isFromMe={isFromMe} showTail={showTail} />;
    case 'video':
      return <VideoPlayer att={att} isFromMe={isFromMe} showTail={showTail} />;
    case 'contact':
      return <ContactCard att={att} isFromMe={isFromMe} />;
    case 'location':
      return <LocationCard att={att} isFromMe={isFromMe} />;
    case 'audio':
      return (
        <LoadErrorBoundary fallback={<FileChip att={att} isFromMe={isFromMe} />}>
          <Suspense fallback={<FileChip att={att} isFromMe={isFromMe} />}>
            <AudioAttachment att={att} isFromMe={isFromMe} />
          </Suspense>
        </LoadErrorBoundary>
      );
    default:
      return <FileChip att={att} isFromMe={isFromMe} />;
  }
}
