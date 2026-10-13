import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
// SDK 57's root expo-media-library is the class-based API (async getters, MediaType.VIDEO); the
// /legacy entry keeps the imperative getAssetsAsync + plain-property Assets we use here.
import * as MediaLibrary from 'expo-media-library/legacy';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { logger } from '@core/secure';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { Icon } from '../primitives';
import { useTheme } from '../theme';
import { showToast } from '../toast/toastStore';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

/** A photo/video/file the composer has staged but not yet sent (shape sendImages accepts). */
export interface PendingAttachment {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  /** Preserved while a native-owned transient file moves into ordinary attachment storage. */
  origin?: 'paste' | 'share';
  /** Stable native-share manifest ordinal used only for crash-safe handoff receipts. */
  shareItemIndex?: number;
}

export const ATTACHMENT_TRAY_HEIGHT = 104;
const THUMB = 84;
type MediaPermissionState =
  'checking' | 'rationale' | 'requesting' | 'granted' | 'retry' | 'settings' | 'unavailable';

function hasMediaAccess(permission: {
  granted: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
}): boolean {
  return permission.granted || permission.accessPrivileges === 'limited';
}

/** Best-effort MIME from a filename extension (MediaLibrary doesn't hand back a mimeType). */
function mimeFromName(name: string, isVideo: boolean): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    heic: 'image/heic',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
  };
  return map[ext] ?? (isVideo ? 'video/mp4' : 'image/jpeg');
}

interface AttachmentTrayProps {
  /** Stage a selected device photo/video onto the composer's pending list. */
  onPick: (item: PendingAttachment) => void;
  /** Open the document picker for non-media files (PDFs, etc.). */
  onPickFiles: () => void;
  /** Pick a device contact and send it as a card. Omitted when the server can't build vCards, so
   *  the "Contact" button appears only when its RCS chat supports interactive attachments. */
  onPickContact?: () => void;
  /** Confirm and send one foreground-acquired current location. */
  onShareLocation?: () => void;
  /** False when the tray exists only for non-media actions such as Location. */
  mediaEnabled?: boolean;
  /** The first iMessage upload slice accepts a single bounded still image with known bytes. */
  imessageImageOnly?: boolean;
}

/**
 * Inline attachment tray — a horizontal strip of the device's recent photos/videos plus a
 * "Files" button. Replaces the old Alert→system-picker popup: tapping a thumbnail stages it as
 * a pending preview in the composer (no modal). Reads media-library permission on first open,
 * explains the optional access in-app, and only launches Android's prompt after Continue.
 */
export function AttachmentTray({
  onPick,
  onPickFiles,
  onPickContact,
  onShareLocation,
  mediaEnabled = true,
  imessageImageOnly = false,
}: AttachmentTrayProps): React.JSX.Element {
  const theme = useTheme();
  const accountLease = useScreenAccountLease();
  const mountedRef = useRef(true);
  const awaitingSettingsRef = useRef(false);
  const mediaRequestInFlightRef = useRef(false);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [mediaPermission, setMediaPermission] = useState<MediaPermissionState>('checking');
  const [permissionDialogVisible, setPermissionDialogVisible] = useState(false);
  const [cameraPermissionIssue, setCameraPermissionIssue] = useState<
    'denied' | 'unavailable' | null
  >(null);
  const isCurrent = useCallback(
    () => mountedRef.current && accountLease.isCurrent(),
    [accountLease],
  );

  const loadAssets = useCallback(async (): Promise<void> => {
    if (!isCurrent()) return;
    try {
      const result = await MediaLibrary.getAssetsAsync({
        first: 40,
        mediaType: imessageImageOnly
          ? [MediaLibrary.MediaType.photo]
          : [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      if (!isCurrent()) return;
      setAssets(result.assets);
      setMediaPermission('granted');
      setPermissionDialogVisible(false);
    } catch (error) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] could not load media library', error);
      setMediaPermission('unavailable');
      setPermissionDialogVisible(true);
    }
  }, [imessageImageOnly, isCurrent]);

  const readableImageSize = async (uri: string): Promise<number | null> => {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!isCurrent()) return null;
      if (info.exists && Number.isSafeInteger(info.size) && info.size > 0) return info.size;
    } catch {
      // An inaccessible media-library URI is not eligible for a new one-shot send.
    }
    if (isCurrent()) showToast('Couldn’t read this photo for sending');
    return null;
  };

  const inspectMediaPermission = useCallback(async (): Promise<void> => {
    if (!isCurrent()) return;
    try {
      // This is status-only. Android's prompt is owned exclusively by requestMediaPermission below.
      const permission = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
      if (!isCurrent()) return;
      if (hasMediaAccess(permission)) {
        await loadAssets();
        return;
      }
      const nextState =
        permission.status === 'undetermined'
          ? 'rationale'
          : permission.canAskAgain
            ? 'retry'
            : 'settings';
      setMediaPermission(nextState);
      setPermissionDialogVisible(true);
    } catch (error) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] could not check media-library permission', error);
      setMediaPermission('unavailable');
      setPermissionDialogVisible(true);
    }
  }, [isCurrent, loadAssets]);

  useEffect(() => {
    mountedRef.current = true;
    if (!mediaEnabled) {
      let cancelled = false;
      // Capability loss must clear any prior media result without synchronously cascading a render
      // from this effect. The local fence prevents this cleanup from racing a later re-enable.
      void Promise.resolve().then(() => {
        if (cancelled || !mountedRef.current) return;
        setAssets([]);
        setPermissionDialogVisible(false);
      });
      return () => {
        cancelled = true;
        mountedRef.current = false;
      };
    }
    const unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(
      accountLease.generation,
      () => {
        awaitingSettingsRef.current = false;
        mediaRequestInFlightRef.current = false;
        setAssets([]);
        setMediaPermission('checking');
        setPermissionDialogVisible(false);
      },
    );
    void (async () => {
      await inspectMediaPermission();
    })();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !awaitingSettingsRef.current) return;
      awaitingSettingsRef.current = false;
      void inspectMediaPermission();
    });
    return () => {
      mountedRef.current = false;
      unsubscribeInvalidation();
      subscription.remove();
    };
  }, [accountLease.generation, inspectMediaPermission, mediaEnabled]);

  const requestMediaPermission = async (): Promise<void> => {
    if (!isCurrent() || mediaRequestInFlightRef.current) return;
    mediaRequestInFlightRef.current = true;
    // The purpose was already shown. Let Android own the foreground while its native prompt is
    // open so an interrupted native promise can never trap the user behind our local dialog.
    setPermissionDialogVisible(false);
    setMediaPermission('requesting');
    try {
      // Ask only for the two categories this tray renders. The SDK default also requests
      // READ_MEDIA_AUDIO, which has no matching user flow in Gator.
      const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      if (!isCurrent()) return;
      if (hasMediaAccess(permission)) {
        await loadAssets();
        return;
      }
      setMediaPermission(permission.canAskAgain ? 'retry' : 'settings');
      setPermissionDialogVisible(true);
    } catch (error) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] could not request media-library permission', error);
      setMediaPermission('unavailable');
      setPermissionDialogVisible(true);
    } finally {
      mediaRequestInFlightRef.current = false;
    }
  };

  const openMediaSettings = async (): Promise<void> => {
    if (!isCurrent()) return;
    awaitingSettingsRef.current = true;
    setPermissionDialogVisible(false);
    try {
      await Linking.openSettings();
    } catch (error) {
      awaitingSettingsRef.current = false;
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] could not open app settings', error);
      setMediaPermission('unavailable');
      setPermissionDialogVisible(true);
    }
  };

  // Capture a fresh photo with the system camera and stage it (parity with the old composer's
  // camera button). CAMERA is already declared by the expo-camera plugin, so no rebuild is needed.
  const capture = async (): Promise<void> => {
    if (!isCurrent()) return;
    let permission: Awaited<ReturnType<typeof ImagePicker.requestCameraPermissionsAsync>>;
    try {
      permission = await ImagePicker.requestCameraPermissionsAsync();
    } catch (error) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] camera permission request failed', error);
      setCameraPermissionIssue('unavailable');
      return;
    }
    if (!isCurrent()) return;
    if (!permission.granted) {
      setCameraPermissionIssue('denied');
      return;
    }
    if (cameraPermissionIssue) setCameraPermissionIssue(null);
    try {
      const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!isCurrent()) return;
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      const isVideo = a.type === 'video';
      if (imessageImageOnly && isVideo) return;
      const size =
        imessageImageOnly && !(a.fileSize && a.fileSize > 0)
          ? await readableImageSize(a.uri)
          : (a.fileSize ?? 0);
      if (size === null || !isCurrent()) return;
      onPick({
        uri: a.uri,
        name: a.fileName ?? `capture.${isVideo ? 'mp4' : 'jpg'}`,
        mimeType: a.mimeType ?? mimeFromName(a.fileName ?? (isVideo ? '.mp4' : '.jpg'), isVideo),
        size,
        width: a.width,
        height: a.height,
      });
    } catch (e) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] camera capture failed', e);
    }
  };

  const pick = async (asset: MediaLibrary.Asset): Promise<void> => {
    if (!isCurrent()) return;
    const isVideo = asset.mediaType === MediaLibrary.MediaType.video;
    if (imessageImageOnly && isVideo) return;
    // getAssetInfoAsync resolves a readable file:// localUri (the raw asset uri can be a
    // non-readable content/ph reference). It can THROW under Android scoped storage / limited
    // photo access — if it does, fall back to the asset's own uri so the pick STILL stages
    // instead of silently vanishing (which reads to the user as "tapping does nothing").
    let uri = asset.uri;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      if (!isCurrent()) return;
      if (info.localUri) uri = info.localUri;
    } catch (e) {
      if (!isCurrent()) return;
      logger.warn('[attachment-tray] getAssetInfoAsync failed; staging raw asset uri', e);
    }
    if (!isCurrent()) return;
    const size = imessageImageOnly ? await readableImageSize(uri) : 0;
    if (size === null || !isCurrent()) return;
    onPick({
      uri,
      name: asset.filename,
      mimeType: mimeFromName(asset.filename, isVideo),
      size,
      width: asset.width,
      height: asset.height,
    });
  };

  const permissionPurpose =
    'Gator can show recent photos and videos here for you to attach. Access is optional; Camera and Files still work without it.';
  const permissionDetail =
    mediaPermission === 'retry'
      ? "Android previously denied access. Try again or open Gator's app settings."
      : mediaPermission === 'settings'
        ? "Android won't ask again. Open Gator's app settings to allow photos and videos."
        : mediaPermission === 'unavailable'
          ? "Gator couldn't check photo and video access. Check again or open Gator's app settings."
          : mediaPermission === 'requesting'
            ? "Waiting for Android's photo and video choice…"
            : null;
  const permissionRequestAction =
    mediaPermission === 'rationale'
      ? 'Continue'
      : mediaPermission === 'retry'
        ? 'Try Again'
        : mediaPermission === 'unavailable'
          ? 'Check Again'
          : null;
  const canOpenMediaSettings =
    mediaPermission === 'retry' ||
    mediaPermission === 'settings' ||
    mediaPermission === 'unavailable';

  const runPermissionRequestAction = (): void => {
    if (mediaPermission === 'unavailable') {
      setMediaPermission('checking');
      void inspectMediaPermission();
      return;
    }
    void requestMediaPermission();
  };

  return (
    <View style={[styles.wrap, { borderTopColor: theme.color.separator }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {mediaEnabled ? (
          <>
            <Pressable
              onPress={() => void capture()}
              style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
              accessibilityRole="button"
              accessibilityLabel="Take a photo"
            >
              <Icon name="camera-outline" size={26} color={theme.color.tint} />
              <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Camera</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                if (isCurrent()) onPickFiles();
              }}
              style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
              accessibilityRole="button"
              accessibilityLabel="Attach a file"
            >
              <Icon name="document-outline" size={26} color={theme.color.tint} />
              <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Files</Text>
            </Pressable>
          </>
        ) : null}

        {onShareLocation ? (
          <Pressable
            onPress={() => {
              if (isCurrent()) onShareLocation();
            }}
            style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
            accessibilityRole="button"
            accessibilityLabel="Send current location"
          >
            <Icon name="location-outline" size={26} color={theme.color.tint} />
            <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Location</Text>
          </Pressable>
        ) : null}

        {onPickContact ? (
          <Pressable
            onPress={() => {
              if (isCurrent()) onPickContact();
            }}
            style={[styles.files, { backgroundColor: theme.color.secondaryBackground }]}
            accessibilityRole="button"
            accessibilityLabel="Send a contact"
          >
            <Icon name="person-outline" size={26} color={theme.color.tint} />
            <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Contact</Text>
          </Pressable>
        ) : null}

        {mediaEnabled && cameraPermissionIssue ? (
          <View style={styles.msg}>
            <Text style={[styles.msgText, { color: theme.color.secondaryLabel }]}>
              {cameraPermissionIssue === 'denied'
                ? 'Camera access was denied. Enable it in system settings to take a photo.'
                : "Gator couldn't request camera access. Try Camera again or check Gator's permission in system settings."}
            </Text>
          </View>
        ) : null}

        {mediaEnabled && mediaPermission === 'granted' ? (
          assets.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => void pick(a)}
              style={styles.thumbWrap}
              accessibilityRole="button"
              accessibilityLabel={
                a.mediaType === MediaLibrary.MediaType.video ? 'Attach video' : 'Attach photo'
              }
            >
              <Image source={{ uri: a.uri }} style={styles.thumb} contentFit="cover" />
              {a.mediaType === MediaLibrary.MediaType.video ? (
                <View style={styles.videoBadge}>
                  <Icon name="videocam" size={12} color="#fff" />
                </View>
              ) : null}
            </Pressable>
          ))
        ) : mediaEnabled ? (
          <Pressable
            onPress={() => setPermissionDialogVisible(true)}
            disabled={mediaPermission === 'checking' || mediaPermission === 'requesting'}
            style={[
              styles.files,
              {
                backgroundColor: theme.color.secondaryBackground,
                opacity:
                  mediaPermission === 'checking' || mediaPermission === 'requesting' ? 0.55 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Review photo and video access"
            accessibilityState={{
              disabled: mediaPermission === 'checking' || mediaPermission === 'requesting',
            }}
          >
            <Icon name="images-outline" size={24} color={theme.color.tint} />
            <Text style={[styles.filesText, { color: theme.color.secondaryLabel }]}>Photos</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <Modal
        visible={
          mediaEnabled &&
          permissionDialogVisible &&
          mediaPermission !== 'checking' &&
          mediaPermission !== 'granted'
        }
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (mediaPermission !== 'requesting') setPermissionDialogVisible(false);
        }}
      >
        <View style={styles.dialogBackdrop}>
          <View
            style={[styles.dialog, { backgroundColor: theme.color.background }]}
            accessibilityViewIsModal
          >
            <Text style={[styles.dialogTitle, { color: theme.color.label }]}>
              Photos and videos
            </Text>
            <Text style={[styles.dialogMessage, { color: theme.color.secondaryLabel }]}>
              {permissionPurpose}
              {permissionDetail ? ` ${permissionDetail}` : ''}
            </Text>
            <View style={styles.dialogActions}>
              {mediaPermission !== 'requesting' ? (
                <Pressable
                  onPress={() => setPermissionDialogVisible(false)}
                  style={[
                    styles.dialogButton,
                    { backgroundColor: theme.color.secondaryBackground },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Not Now"
                >
                  <Text style={[styles.dialogButtonText, { color: theme.color.label }]}>
                    Not Now
                  </Text>
                </Pressable>
              ) : null}
              {canOpenMediaSettings ? (
                <Pressable
                  onPress={() => void openMediaSettings()}
                  style={[
                    styles.dialogButton,
                    { backgroundColor: theme.color.secondaryBackground },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Open Settings"
                >
                  <Text style={[styles.dialogButtonText, { color: theme.color.tint }]}>
                    Open Settings
                  </Text>
                </Pressable>
              ) : null}
              {permissionRequestAction ? (
                <Pressable
                  onPress={runPermissionRequestAction}
                  style={[styles.dialogButton, { backgroundColor: theme.color.tint }]}
                  accessibilityRole="button"
                  accessibilityLabel={permissionRequestAction}
                >
                  <Text style={[styles.dialogButtonText, { color: theme.color.background }]}>
                    {permissionRequestAction}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: ATTACHMENT_TRAY_HEIGHT, borderTopWidth: StyleSheet.hairlineWidth },
  row: { alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  files: {
    width: THUMB,
    height: THUMB,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  filesText: { fontSize: 12, fontWeight: '600' },
  thumbWrap: { width: THUMB, height: THUMB, borderRadius: 10, overflow: 'hidden' },
  thumb: { width: THUMB, height: THUMB },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    padding: 2,
  },
  msg: { height: THUMB, justifyContent: 'center', paddingHorizontal: 12, maxWidth: 240 },
  msgText: { fontSize: 13 },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: { width: '100%', maxWidth: 420, borderRadius: 18, padding: 20, gap: 16 },
  dialogTitle: { fontSize: 20, fontWeight: '700' },
  dialogMessage: { fontSize: 16, lineHeight: 23 },
  dialogActions: { gap: 10 },
  dialogButton: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    alignItems: 'center',
  },
  dialogButtonText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
});
