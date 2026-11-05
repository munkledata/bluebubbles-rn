import { useRouter } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { logger } from '@core/secure';
import { removeChatDownloadedFiles } from '@/services/download/removeChatDownloads';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { loadChatDownloadedFilesSummary } from '@features/storage/chatDownloads';
import { useStorageBreakdown } from '@features/storage/useStorageBreakdown';
import { InfoRow, NoteRow, Screen, ScreenHeader, SettingsSection } from '@ui';
import { showDialog } from '@ui/dialog/dialogStore';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { showToast } from '@ui/toast/toastStore';
import { friendlySize } from '@utils';

const filesLabel = (files: number): string =>
  `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}`;
const usage = (bytes: number, files: number): string =>
  `${friendlySize(bytes) || '0 B'} · ${filesLabel(files)}`;

/** The toast after a removal: what went, what stayed, and why. */
function removalSummary(result: { removed: number; failed: number; kept: number }): string {
  const parts = [
    result.removed > 0 ? `Removed ${filesLabel(result.removed)}.` : 'Nothing was removed.',
  ];
  if (result.kept > 0) {
    parts.push(
      `${filesLabel(result.kept)} ${result.kept === 1 ? 'was' : 'were'} kept because Gator is still using ${result.kept === 1 ? 'it' : 'them'}.`,
    );
  }
  if (result.failed > 0) {
    parts.push(`${filesLabel(result.failed)} couldn’t be removed yet; Gator will try again later.`);
  }
  return parts.join(' ');
}

/** Storage Analyzer: how much space downloaded files take, and which chats use the most. */
export default function StorageAnalyzerScreen(): React.JSX.Element {
  const router = useRouter();
  const accountLease = useScreenAccountLease();
  const breakdown = useStorageBreakdown();
  // isCurrent() alone isn't reactive: subscribe so Disconnect hides the old account's numbers at once.
  const [retired, setRetired] = useState(() => !accountLease.isCurrent());
  useLayoutEffect(
    () => subscribeRealtimeGenerationInvalidation(accountLease.generation, () => setRetired(true)),
    [accountLease],
  );
  const data = retired ? null : breakdown;
  const retiredRef = useRef(retired);
  retiredRef.current = retired;
  const [removing, setRemoving] = useState<string | null>(null);
  const busyRef = useRef(false);
  const current = (): boolean => !retiredRef.current && accountLease.isCurrent();

  const remove = async (chatGuid: string): Promise<void> => {
    busyRef.current = true;
    setRemoving(chatGuid);
    try {
      const result = await removeChatDownloadedFiles(chatGuid, accountLease);
      if (result.status === 'complete' && current()) showToast(removalSummary(result));
    } catch (error) {
      logger.warn('[storage] removing a chat’s downloaded files failed', error);
      if (current()) showToast('Couldn’t remove the downloaded files. Try again later.');
    } finally {
      busyRef.current = false;
      setRemoving(null);
    }
  };

  const confirmRemove = async (chatGuid: string, title: string): Promise<void> => {
    if (busyRef.current || !current()) return;
    busyRef.current = true;
    // busyRef stays set until a dialog button is pressed, so no second dialog can queue up.
    const release = (): void => {
      busyRef.current = false;
    };
    let summary;
    try {
      summary = await loadChatDownloadedFilesSummary(chatGuid);
    } catch (error) {
      release();
      logger.warn('[storage] reading a chat’s downloaded files failed', error);
      if (current()) showToast('Couldn’t check this chat’s downloaded files.');
      return;
    }
    if (!current()) {
      release();
      return;
    }
    const kept =
      summary.keptFiles > 0
        ? ` ${filesLabel(summary.keptFiles)} ${summary.keptFiles === 1 ? 'stays' : 'stay'}, because another chat or Gator still uses ${summary.keptFiles === 1 ? 'it' : 'them'}.`
        : '';
    if (summary.files === 0) {
      showDialog(
        'Nothing to remove',
        `${title} has no downloaded files that can be removed.${kept}`,
        [{ text: 'OK', onPress: release }],
      );
      return;
    }
    showDialog(
      `Remove downloaded files for ${title}?`,
      `${usage(summary.bytes, summary.files)} will be removed from this phone. Messages stay, and each file downloads again when you open it.${kept}`,
      [
        { text: 'Cancel', style: 'cancel', onPress: release },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            release();
            if (current()) void remove(chatGuid);
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <ScreenHeader title="Storage Analyzer" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="DOWNLOADED FILES">
          <InfoRow label="Total" value={data ? usage(data.totalBytes, data.totalFiles) : '—'} />
          <NoteRow text="Photos, videos and files this phone has downloaded. Removing them only frees space here; they download again when you open them." />
        </SettingsSection>

        <SettingsSection label="LARGEST CHATS" style={styles.gap}>
          {data && data.topChats.length > 0 ? (
            data.topChats.map((chat) => {
              const title = data.titles[chat.chatGuid] ?? 'Conversation';
              const busy = removing === chat.chatGuid;
              return (
                <Pressable
                  key={chat.chatGuid}
                  onPress={() => void confirmRemove(chat.chatGuid, title)}
                  disabled={removing != null}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${title}, ${usage(chat.bytes, chat.files)}`}
                  accessibilityHint="Offers to remove this chat’s downloaded files from the phone"
                  accessibilityState={{ disabled: removing != null, busy }}
                >
                  <InfoRow
                    label={title}
                    value={busy ? 'Removing…' : usage(chat.bytes, chat.files)}
                  />
                </Pressable>
              );
            })
          ) : (
            <NoteRow text={data ? 'No downloaded files yet.' : 'Loading…'} />
          )}
          {data && data.otherFiles > 0 ? (
            <InfoRow label="Other files" value={usage(data.otherBytes, data.otherFiles)} />
          ) : null}
          {data && data.otherFiles > 0 ? (
            <NoteRow text="Other files are wallpapers, group photos and contact pictures. A file shared in two chats counts in both." />
          ) : null}
          {data && data.topChats.length > 0 ? (
            <NoteRow text="Tap a chat to remove its downloaded files from this phone." />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: 16 },
  gap: { marginTop: 24 },
});
