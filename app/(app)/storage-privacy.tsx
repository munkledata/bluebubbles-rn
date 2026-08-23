import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

/** Truthful boundary between SQLCipher rows and ordinary app-private files. */
export default function StoragePrivacyScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const textStyle = [styles.text, { color: theme.color.secondaryLabel }];

  return (
    <Screen>
      <ScreenHeader title="Storage & File Privacy" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="ENCRYPTED DATABASE">
          <Text style={textStyle}>
            Messages, contacts, drafts, reminders, and most non-secret preferences are stored in a
            SQLCipher-encrypted database. Server credentials, the database key, the App Lock flag,
            and a small set of boot-time secrets are kept separately in Android secure storage. App
            Lock does not make the database key biometric-bound.
          </Text>
        </SettingsSection>

        <SettingsSection label="FILES OUTSIDE THE DATABASE" style={styles.gap}>
          <Text style={textStyle}>
            Downloaded or staged attachments, chat wallpapers and synced backgrounds, cached contact
            images, app logs, incoming-share copies, and image or WebView caches are ordinary files.
            Android keeps them in Gator’s app-private folders, so normal apps cannot browse them,
            but SQLCipher and App Lock do not encrypt those files.
          </Text>
          <Text style={textStyle}>
            Attachments you save to Photos—and images automatically exported to Photos or the Gator
            album when that setting is enabled—are separate copies in Android’s shared media
            storage. Other apps with media access can see them.
          </Text>
        </SettingsSection>

        <SettingsSection label="CLEANUP" style={styles.gap}>
          <Text style={textStyle}>
            Gator limits its ordinary downloaded-attachment cache to 2 GiB and 4,096 files while
            preserving at least 512 MiB of free app storage. It removes the least recently used old
            files first. Files currently on screen, used by an in-progress operation, or needed for
            an outgoing send are protected; a new download is refused when space cannot be freed
            safely. Android 7 devices keep persistent attachment downloads disabled because the
            bounded startup inventory requires Android 8 or newer.
          </Text>
          <Text style={textStyle}>
            Deleting a chat removes Gator-owned downloaded files after its database purge when
            possible. Disconnecting clears the account’s database contents, attachments, contact
            images, wallpapers, and app logs before another account can connect. If required cleanup
            cannot be confirmed, Gator blocks the next connection so the cleanup can be retried. It
            does not delete copies exported to Photos or the Gator album; remove those in your
            Photos app. Temporary cache files may remain until Gator or Android removes them. Clear
            App Logs deletes the saved log and tells you if Android cannot confirm removal. Release
            builds retain only structured error diagnostics; development builds may keep extra local
            diagnostics, but Share errors exports only the structured errors. Clearing app data or
            uninstalling removes Gator’s app-private files but not exported media copies.
          </Text>
        </SettingsSection>

        <SettingsSection label="BACKUPS" style={styles.gap}>
          <Text style={textStyle}>
            The current export flow encrypts a backup before writing its temporary share file and
            deletes that temporary file after the share sheet closes. A copy you save to Files,
            Drive, or another app remains there until you delete it. Gator can still import older
            plaintext backup files but does not offer plaintext export in the app.
          </Text>
        </SettingsSection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  gap: { marginTop: 20 },
  text: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 },
});
