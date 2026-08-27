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
        <SettingsSection label="SERVER & MESSAGING">
          <Text style={textStyle}>
            To provide messaging, Gator exchanges messages, participants, attachments, delivery and
            read updates, reactions, call and Find My requests, and account or server status with
            the self-hosted server you connect. Your server credentials authenticate those requests.
            HTTPS is recommended. Gator also allows an HTTP connection after you approve a clear
            warning, but HTTP does not protect this traffic from network observers.
          </Text>
          <Text style={textStyle}>
            Your server and Mac control their own copies and retention. Disconnecting removes the
            account data stored by Gator on this device, but it does not delete conversations or
            files stored by your server or Mac. Deleting a chat or message in Gator is also
            local-only. Delete server or Mac copies there, or ask the server operator.
          </Text>
        </SettingsSection>

        <SettingsSection label="CONTACTS" style={styles.gap}>
          <Text style={textStyle}>
            With your permission, Sync Contacts reads names, phone numbers, email addresses, and
            contact photo references into Gator’s encrypted local database so message addresses can
            show familiar names and photos. To find missing server contact photos, Gator may send up
            to 64 existing chat phone or email addresses per sync to your connected server; it does
            not upload your whole address book. If you choose Send Contact, the selected name,
            organization, phone numbers, and email addresses are sent through your server as a
            contact card; the device contact photo is not sent.
          </Text>
          <Text style={textStyle}>
            Synced device-contact entries and Android’s Contacts permission remain after Disconnect
            by design. Revoking the permission stops future reads. To remove Gator’s stored contact
            copy, clear its app data or uninstall it.
          </Text>
        </SettingsSection>

        <SettingsSection label="PUSH DELIVERY" style={styles.gap}>
          <Text style={textStyle}>
            When push is configured, Gator registers this installation’s Firebase Cloud Messaging
            (FCM) token and device label with your connected server. Push event data then passes
            from that server through Google FCM to this device. Gator’s own push-payload encryption
            depends on the server’s push setting, so it is not always enabled. While App Lock is
            engaged, a newly received push produces a generic notice without opening the encrypted
            database.
          </Text>
        </SettingsSection>

        <SettingsSection label="ERROR REPORTS" style={styles.gap}>
          <Text style={textStyle}>
            On a new or unset installation, Share Error Reports starts off. If you turn it on and
            your server supports report uploads, Gator sends only bounded technical fields to your
            connected server—not the original error message or stack trace. Turning it off stops new
            report capture and upload and deletes queued reports. Disconnecting also clears the
            local report queue.
          </Text>
        </SettingsSection>

        <SettingsSection label="LINKS, MAPS & CALLS" style={styles.gap}>
          <Text style={textStyle}>
            Merely viewing a message or Find My screen does not download third-party link previews
            or map tiles. Embedded map and FaceTime WebViews are disabled. When you explicitly open
            a web link, location, or validated FaceTime link, Android hands it to an external
            browser or maps app. That external provider may receive the URL or precise coordinates
            and, for a Find My location, its displayed label.
          </Text>
        </SettingsSection>

        <SettingsSection label="SCREEN PRIVACY" style={styles.gap}>
          <Text style={textStyle}>
            Gator no longer has a configurable Redacted Mode or Hide Preview mode. App Lock is a
            foreground screen gate; it is not file encryption or biometric-bound key custody. It
            does not guarantee protection from screenshots, screen recording, or every Recents
            snapshot, and it does not retroactively replace detailed notifications that Android
            already displayed.
          </Text>
        </SettingsSection>

        <SettingsSection label="ENCRYPTED DATABASE" style={styles.gap}>
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
            builds retain structured error diagnostics plus a small push-receipt record containing a
            minute-rounded receipt time, the server event category, and whether delivery was
            foreground or background. Development builds may keep extra local diagnostics, but Share
            diagnostics exports only the structured errors and finite receipt events. Clearing app
            data or uninstalling removes Gator’s app-private files but not exported media copies.
          </Text>
        </SettingsSection>

        <SettingsSection label="BACKUPS" style={styles.gap}>
          <Text style={textStyle}>
            A backup contains your theme, selected app settings, and per-chat customizations—not
            messages, drafts, diagnostic consent, or credentials. The current export flow encrypts
            it before writing a temporary share file and attempts to delete that file after the
            share sheet closes. A copy you save to Files, Drive, or another app remains there until
            you delete it. Gator can still import older plaintext backup files but does not offer
            plaintext export in the app.
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
