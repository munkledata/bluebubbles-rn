import { useCallback } from 'react';
import { logger } from '@core/secure';
import { MAX_IMESSAGE_VOICE_UPLOAD_BYTES } from '@core/models/serverInfo';
import type { ShareIntakeManifestIdentity } from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import {
  sendImage,
  sendImages,
  sendTextAttachment,
  sendVoice,
  type AttachmentQueueAdmission,
} from '@/services/send';
import { showToast, type PendingAttachment } from '@ui';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { showDialog } from '@ui/dialog/dialogStore';
import type { resolveChatService } from '@utils';
import { imessageAttachmentRefusal } from './imessageAttachmentRefusal';
import { observeQueueAdmission } from './observeQueueAdmission';
import type { ChatCapabilities } from './useChatCapabilities';

interface DocumentPickerModule {
  getDocumentAsync(options: {
    multiple: boolean;
    copyToCacheDirectory: boolean;
    type?: string[];
  }): Promise<{
    canceled: boolean;
    assets: Array<{
      uri: string;
      name: string;
      mimeType?: string | null;
      size?: number | null;
    }> | null;
  }>;
}

type DocumentPickerLoader = () => Promise<DocumentPickerModule>;

const RCS_TOO_LARGE_TOAST =
  'A file is larger than RCS allows (100 MiB), so it wasn’t sent. Remove it from your message.';

/**
 * Open the account-neutral OS picker, then accept its result only if the screen that opened it
 * still owns the active account. The loader is injectable solely to make the delayed native-return
 * boundary deterministic in Node tests; production retains the lazy native import.
 */
export async function pickDocumentFilesForLease(
  accountLease: { isCurrent(): boolean },
  loadPicker: DocumentPickerLoader = () => import('expo-document-picker'),
  imessageAttachmentOnly = false,
  imessagePdfAvailable = false,
): Promise<PendingAttachment[]> {
  try {
    const DocumentPicker = await loadPicker();
    if (!accountLease.isCurrent()) return [];
    const res = await DocumentPicker.getDocumentAsync({
      multiple: !imessageAttachmentOnly,
      copyToCacheDirectory: true,
      ...(imessageAttachmentOnly
        ? {
            type: ['image/jpeg', 'image/png', ...(imessagePdfAvailable ? ['application/pdf'] : [])],
          }
        : {}),
    });
    if (!accountLease.isCurrent() || res.canceled || !res.assets || res.assets.length === 0) {
      return [];
    }
    return res.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? 'application/octet-stream',
      size: asset.size ?? 0,
    }));
  } catch {
    if (accountLease.isCurrent()) showDialog('Attach', 'Couldn’t open the file picker.');
    return [];
  }
}

export interface ChatAttachmentSendOptions {
  guid: string;
  accountLease: RealtimeDeliveryLease;
  chatService: ReturnType<typeof resolveChatService>;
  capabilities: Pick<
    ChatCapabilities,
    | 'attachmentFeaturesAvailable'
    | 'imessageAttachmentFeaturesAvailable'
    | 'imessagePdfFeaturesAvailable'
    | 'imessageCaptionFeaturesAvailable'
    | 'voiceFeaturesAvailable'
    | 'imessageVoiceAvailable'
  >;
  /** The native share this chat route owns, so its files are copied out of the share queue. */
  ownedShareIdentity: ShareIntakeManifestIdentity | null;
}

/**
 * The composer's file sends for the open chat: picking documents, sending staged attachments,
 * one attachment with text, and voice recordings. iMessage chats accept only the single-file
 * types the server advertises. Each send resolves once the files reach the durable queue; anything
 * not queued stays in the composer.
 */
export function useChatAttachmentSends({
  guid,
  accountLease,
  chatService,
  capabilities,
  ownedShareIdentity,
}: ChatAttachmentSendOptions) {
  const {
    attachmentFeaturesAvailable,
    imessageAttachmentFeaturesAvailable,
    imessagePdfFeaturesAvailable,
    imessageCaptionFeaturesAvailable,
    voiceFeaturesAvailable,
    imessageVoiceAvailable,
  } = capabilities;

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = useCallback(
    (): Promise<PendingAttachment[]> =>
      attachmentFeaturesAvailable
        ? pickDocumentFilesForLease(
            accountLease,
            undefined,
            imessageAttachmentFeaturesAvailable,
            imessagePdfFeaturesAvailable,
          )
        : Promise.resolve([]),
    [
      accountLease,
      attachmentFeaturesAvailable,
      imessageAttachmentFeaturesAvailable,
      imessagePdfFeaturesAvailable,
    ],
  );

  // The rest of the Composer's callback props, useCallback-stable for the same memo reason.
  const onSendAttachments = useCallback(
    (items: PendingAttachment[]): Promise<readonly string[]> => {
      if (!attachmentFeaturesAvailable) return Promise.resolve([]);
      if (imessageAttachmentFeaturesAvailable) {
        const refusal = imessageAttachmentRefusal(items, imessagePdfFeaturesAvailable);
        if (refusal !== null) {
          showToast(refusal);
          return Promise.resolve([]);
        }
      }
      const expectedUris = new Set(items.map((item) => item.uri));
      const decidedUris = new Set<string>();
      const queuedUris = new Set<string>();
      let reportedFailure = false;

      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve([...queuedUris]);
        };
        const onAdmission = (admission: AttachmentQueueAdmission): void => {
          if (!accountLease.isCurrent()) return;
          if (!expectedUris.has(admission.uri) || decidedUris.has(admission.uri)) return;
          decidedUris.add(admission.uri);
          if (admission.queued) queuedUris.add(admission.uri);
          else if (!reportedFailure && accountLease.isCurrent()) {
            reportedFailure = true;
            showToast(
              admission.reason === 'file-name'
                ? 'A file’s name can’t be sent. Rename it without quotes or slashes (and shorter if it’s very long), then attach it again.'
                : admission.reason === 'too-large'
                  ? RCS_TOO_LARGE_TOAST
                  : 'Couldn’t queue one or more attachments. They’re still in your composer—try again when connected',
            );
          }
          if (decidedUris.size === expectedUris.size) finish();
        };

        let operation: Promise<unknown>;
        try {
          operation = Promise.resolve(
            sendImages(
              {
                chatGuid: guid,
                images: items,
                shareIntake: ownedShareIdentity ?? undefined,
                ...(imessageAttachmentFeaturesAvailable ? { service: 'iMessage' as const } : {}),
              },
              accountLease,
              presentSendIssue,
              onAdmission,
            ),
          );
        } catch (error) {
          if (accountLease.isCurrent()) {
            logger.warn('[chat] attachment queue admission failed', error);
            showToast(
              'Couldn’t queue those attachments. They’re still in your composer—try again when connected',
            );
          }
          finish();
          return;
        }

        void operation.then(
          () => finish(),
          (error: unknown) => {
            if (!settled && accountLease.isCurrent()) {
              logger.warn('[chat] attachment queue admission failed', error);
              if (!reportedFailure) {
                showToast(
                  'Couldn’t queue one or more attachments. They’re still in your composer—try again when connected',
                );
              }
            }
            finish();
          },
        );
      });
    },
    [
      accountLease,
      attachmentFeaturesAvailable,
      guid,
      imessageAttachmentFeaturesAvailable,
      imessagePdfFeaturesAvailable,
      ownedShareIdentity,
    ],
  );
  const onSendTextAttachment = useCallback(
    (text: string, item: PendingAttachment): Promise<boolean> | false => {
      if (!attachmentFeaturesAvailable) return false;
      if (chatService === 'iMessage') {
        if (!imessageCaptionFeaturesAvailable) return false;
        const refusal = imessageAttachmentRefusal([item], imessagePdfFeaturesAvailable);
        if (refusal !== null) {
          showToast(refusal);
          return false;
        }
      } else if (chatService !== 'RCS') {
        return false;
      }
      return observeQueueAdmission(
        (onQueued) =>
          sendTextAttachment(
            {
              chatGuid: guid,
              image: item,
              text,
              service: chatService,
              shareIntake: item.origin === 'share' ? (ownedShareIdentity ?? undefined) : undefined,
            },
            accountLease,
            presentSendIssue,
            onQueued,
          ),
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] text-attachment queue admission failed', error);
          // The send refuses an RCS file over the size limit before any upload; retrying cannot help.
          showToast(
            error instanceof Error && error.name === 'RcsAttachmentTooLargeError'
              ? RCS_TOO_LARGE_TOAST
              : 'Couldn’t queue that text and attachment. They’re still in your composer—try again',
          );
        },
      );
    },
    [
      accountLease,
      attachmentFeaturesAvailable,
      chatService,
      guid,
      imessageCaptionFeaturesAvailable,
      imessagePdfFeaturesAvailable,
      ownedShareIdentity,
    ],
  );
  const onSendVoice = useCallback(
    async (uri: string): Promise<boolean | 'too-large'> => {
      if (!accountLease.isCurrent() || !voiceFeaturesAvailable) return false;
      if (imessageVoiceAvailable) {
        if (!uri.startsWith('file://') || !/\.m4a$/i.test(uri)) return false;
        try {
          const FileSystem = await import('expo-file-system/legacy');
          if (!accountLease.isCurrent()) return false;
          const info = await FileSystem.getInfoAsync(uri);
          if (
            !accountLease.isCurrent() ||
            !info.exists ||
            !Number.isSafeInteger(info.size) ||
            info.size <= 0
          ) {
            return false;
          }
          // No retry makes a longer note fit, so the recorder must not offer Try Again.
          if (info.size > MAX_IMESSAGE_VOICE_UPLOAD_BYTES) return 'too-large';
          return observeQueueAdmission(
            (onQueued) =>
              sendVoice(
                {
                  chatGuid: guid,
                  audio: {
                    uri,
                    name: uri.split('/').pop() ?? 'voice.m4a',
                    mimeType: 'audio/mp4',
                    size: info.size,
                  },
                },
                accountLease,
                presentSendIssue,
                onQueued,
              ),
            () => undefined,
            (error) => {
              if (!accountLease.isCurrent()) return;
              logger.warn('[chat] voice note queue admission failed', error);
              showToast('Couldn’t queue that recording. It’s still here—try again when connected');
            },
          );
        } catch (error) {
          if (accountLease.isCurrent()) logger.warn('[chat] voice note file check failed', error);
          return false;
        }
      }
      return observeQueueAdmission(
        (onQueued) =>
          sendImage(
            {
              chatGuid: guid,
              image: {
                uri,
                name: uri.split('/').pop() ?? 'voice.m4a',
                mimeType: 'audio/mp4',
                size: 0,
              },
            },
            accountLease,
            presentSendIssue,
            onQueued,
          ),
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] voice message queue admission failed', error);
          showToast('Couldn’t queue that recording. It’s still here—try again when connected');
        },
      );
    },
    [accountLease, voiceFeaturesAvailable, imessageVoiceAvailable, guid],
  );

  return { pickFiles, onSendAttachments, onSendTextAttachment, onSendVoice };
}
