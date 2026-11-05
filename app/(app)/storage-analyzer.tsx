import { useRouter } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { useStorageBreakdown } from '@features/storage/useStorageBreakdown';
import { InfoRow, NoteRow, Screen, ScreenHeader, SettingsSection } from '@ui';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { friendlySize } from '@utils';

const filesLabel = (files: number): string =>
  `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}`;
const usage = (bytes: number, files: number): string =>
  `${friendlySize(bytes) || '0 B'} · ${filesLabel(files)}`;

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
            data.topChats.map((chat) => (
              <InfoRow
                key={chat.chatGuid}
                label={data.titles[chat.chatGuid] ?? 'Conversation'}
                value={usage(chat.bytes, chat.files)}
              />
            ))
          ) : (
            <NoteRow text={data ? 'No downloaded files yet.' : 'Loading…'} />
          )}
          {data && data.otherFiles > 0 ? (
            <InfoRow label="Other files" value={usage(data.otherBytes, data.otherFiles)} />
          ) : null}
          {data && data.otherFiles > 0 ? (
            <NoteRow text="Other files are wallpapers, group photos and contact pictures. A file shared in two chats counts in both." />
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
