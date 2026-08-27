import { Directory, File, Paths } from 'expo-file-system';
import { adoptNativePastedAttachment } from '@native/boundedDownload';
import type { AttachmentCacheReservationScope } from '../download/attachmentCacheCoordinator';
import { attachmentCacheCoordinator } from '../download/attachmentCacheCoordinator';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from '../download/pathSafety';
import type { AttachmentOwnershipPreparer } from './sendAttachmentService';

const MAX_PASTED_ATTACHMENT_BYTES = 128 * 1024 * 1024;

/**
 * Build the same current ordinary-cache URI that the native ownership boundary independently
 * validates. Constructing File/Directory objects has no filesystem side effect.
 */
function outgoingPasteDestination(
  attachmentGuid: string,
  transferName: string,
  generation: number,
): string {
  const directory = new Directory(
    Paths.document,
    'attachments',
    encodedMediaPathSegment(attachmentGuid),
    mediaGenerationPathSegment(generation),
  );
  return new File(directory, encodedMediaPathSegment(transferName)).uri;
}

/**
 * Bind rich-paste ownership preparation to the account generation that accepted the send.
 *
 * Reservation happens before native movement. Any failure releases the durable reservation;
 * crash recovery then deletes an adopted destination (or confirms a never-created one) without
 * ever publishing an outgoing row that points back into the age-managed paste cache.
 */
export function createOutgoingPasteOwnershipPreparer(
  scope: AttachmentCacheReservationScope,
  isRecoveryReady: () => boolean,
): AttachmentOwnershipPreparer {
  return async ({ db, image, attachmentGuid }) => {
    if (image.origin !== 'paste') return { image };
    if (
      !scope.isCurrent() ||
      !isRecoveryReady() ||
      !Number.isSafeInteger(image.size) ||
      image.size <= 0 ||
      image.size > MAX_PASTED_ATTACHMENT_BYTES
    ) {
      throw new Error('Pasted attachment is no longer available for sending.');
    }

    const destinationUri = outgoingPasteDestination(attachmentGuid, image.name, scope.generation);
    const admission = await attachmentCacheCoordinator.reserve(db, {
      path: destinationUri,
      maxBytes: image.size,
      scope,
    });
    if (admission.status !== 'reserved') {
      throw new Error(
        admission.status === 'storage'
          ? 'Not enough storage is available to send this pasted attachment.'
          : 'Pasted attachment is no longer available for sending.',
      );
    }

    const { reservation } = admission;
    try {
      if (!scope.isCurrent()) {
        throw new Error('Pasted attachment is no longer available for sending.');
      }
      const adopted = await adoptNativePastedAttachment(image.uri, destinationUri, image.size);
      if (!scope.isCurrent()) {
        throw new Error('Pasted attachment is no longer available for sending.');
      }
      return {
        image: { ...image, uri: adopted.uri, size: adopted.bytes },
        cacheReservation: reservation,
      };
    } catch (error) {
      await reservation.release().catch(() => undefined);
      throw error;
    }
  };
}
