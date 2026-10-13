import { useRouter } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { logger } from '@core/secure';
import { NavRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';
import { showDialog } from '@ui/dialog/dialogStore';
import { useForegroundBootState } from '@/features/boot/useForegroundBootState';
import { resolveAttachmentCacheRecoveryIssue } from '@/services/boot/foregroundBoot';
import {
  getDownloadRepairProgress,
  repairStuckDownloads,
  subscribeDownloadRepair,
  type AttachmentCacheRepairResult,
} from '@/services/download';

const REPAIR_CONFIRM_MESSAGE =
  'Gator checks every attachment it has downloaded and removes the oldest ones beyond its normal limits: 2 GiB, 4,096 files, and at least 512 MiB of the phone’s storage kept free. Removed attachments download again when you open them. Files on screen, waiting to be sent, or waiting to be copied to Photos are kept. This can take a few minutes, so keep Gator open.';
const REPAIR_FAILED_MESSAGE =
  'Something unexpected in Gator’s download storage stopped the repair. Try again later. If it keeps failing, disconnecting and reconnecting resets downloaded attachments, along with all other data on this phone.';

function removedSentence(removedFiles: number): string {
  if (removedFiles === 0) return 'No attachments needed to be removed.';
  const noun = removedFiles === 1 ? 'attachment' : 'attachments';
  return `Gator removed ${removedFiles.toLocaleString()} older downloaded ${noun}; they download again when you open them.`;
}

function repairResultDialog(result: AttachmentCacheRepairResult): [string, string] {
  switch (result.status) {
    case 'repaired':
      // Independent review of 888: below 512 MiB free, every removable file goes and downloads
      // can still be refused, so only claim success when the cache is within its limits.
      return result.withinQuota
        ? ['Downloads Repaired', `Downloads work again. ${removedSentence(result.removedFiles)}`]
        : [
            'Downloads Back On',
            `${removedSentence(result.removedFiles)} The phone is still low on storage or some attachments are in use, so a new download may be refused until at least 512 MiB is free.`,
          ];
    case 'not-needed':
      return ['Downloads Already Work', 'Gator had already finished checking its downloads.'];
    case 'blocked':
      return [
        'Couldn’t Finish Repair',
        'Too many attachments are in use or were opened in the last few minutes for Gator to remove enough of them. Try again later.',
      ];
    case 'stale':
      return [
        'Repair Stopped',
        'The repair stopped because Gator disconnected from this account. Try again from Storage & File Privacy.',
      ];
  }
}

/** Truthful boundary between SQLCipher rows and ordinary app-private files. */
export default function StoragePrivacyScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const textStyle = [styles.text, { color: theme.color.secondaryLabel }];
  // Review item 888: startup's attachment check failed, so new downloads stay off until a repair.
  const downloadsPaused = useForegroundBootState().issues.some(
    (issue) => issue.stage === 'attachment-cache',
  );
  // Shared with the service, so leaving and reopening this screen still shows a repair in progress.
  const repairChecked = useSyncExternalStore(subscribeDownloadRepair, getDownloadRepairProgress);

  const runRepair = async (): Promise<void> => {
    if (getDownloadRepairProgress() !== null) return;
    try {
      const result = await repairStuckDownloads();
      if (result.status === 'repaired' || result.status === 'not-needed') {
        resolveAttachmentCacheRecoveryIssue();
      }
      const [title, message] = repairResultDialog(result);
      showDialog(title, message);
    } catch (error) {
      logger.warn('[storage] download repair failed', error);
      showDialog('Couldn’t Repair Downloads', REPAIR_FAILED_MESSAGE);
    }
  };

  const confirmRepair = (): void => {
    if (getDownloadRepairProgress() !== null) return;
    showDialog('Repair Downloads?', REPAIR_CONFIRM_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Repair', onPress: () => void runRepair() },
    ]);
  };

  return (
    <Screen>
      <ScreenHeader title="Storage & File Privacy" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="SERVER & MESSAGING">
          <Text style={textStyle}>
            To provide messaging, Gator exchanges messages, participants, attachments, delivery and
            read updates, reactions, call and Find My requests, and account or server status with
            the self-hosted server you connect. Your server credentials authenticate those requests.
            HTTPS is recommended. Gator trusts only Android&apos;s built-in system certificate
            authorities; certificate authorities added in Android Settings are not accepted. Gator
            also allows an HTTP connection after you approve a clear warning, but HTTP does not
            protect this traffic from network observers.
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
            enabled, new message notices remain generic. A locked V3 push may store an authenticated
            event in the encrypted database for processing after unlock; legacy locked delivery does
            not open the database.
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

        <SettingsSection label="LINKS & MAPS" style={styles.gap}>
          <Text style={textStyle}>
            When your server supports it, viewing a message with a web link automatically asks your
            connected Gator server for bounded preview text and an optional image. This phone does
            not contact the page or image host directly, but your server does; those hosts can learn
            the requested URL and your server&apos;s IP address. Preview data is kept in
            Gator&apos;s bounded, encrypted database cache. While an unlocked Find My screen with
            locations is visible, its native Google map asks Google to center on the server-provided
            precise coordinates and load the displayed map region. Google Maps may receive those
            coordinates, the phone&apos;s IP address, device and request details, a Maps-specific
            identifier, Maps SDK crash diagnostics, and interactions such as panning or zooming.
            Gator does not request this phone&apos;s own location for that map. When you explicitly
            open a web link or location, Android hands it to an external browser or maps app. That
            external provider may receive the URL or precise coordinates and, for a Find My
            location, its displayed label. FaceTime actions appear only when your connected server
            advertises a separately gated capability. Starting a call sends the address you entered
            to that server; Gator does not save that address on the phone. A created FaceTime link
            stays in screen memory unless you explicitly copy it to the system clipboard or open the
            system share sheet.
          </Text>
        </SettingsSection>

        <SettingsSection label="CURRENT LOCATION SHARING" style={styles.gap}>
          <Text style={textStyle}>
            Find My is separate: it displays locations supplied by your server and does not read
            this phone&apos;s location. In a supported one-to-one conversation, Send Current
            Location appears only when your connected server offers it. After you confirm, Gator may
            ask Android for foreground location access and waits up to 15 seconds for one
            approximate or precise fix. Gator does not collect location in the background.
          </Text>
          <Text style={textStyle}>
            After a fix is obtained, Gator stores that coordinate in its SQLCipher-encrypted
            outgoing queue and sends it through your connected server. A temporary failure may retry
            the same stored coordinate for no more than 15 minutes; a retry does not read a new
            location. If you deny permission, cancel, turn off location services, or no fix arrives
            before the timeout, nothing is queued or sent.
          </Text>
        </SettingsSection>

        <SettingsSection label="SCREEN PRIVACY" style={styles.gap}>
          <Text style={textStyle}>
            Gator no longer has a configurable Redacted Mode or Hide Preview mode. App Lock is a
            foreground screen gate; it is not file encryption or biometric-bound key custody. It
            keeps protected content out of Android Recents, including during its grace period. The
            independent Secure Screen setting blocks screenshots and screen recording. Enabling App
            Lock clears displayed notifications and keeps new message notices generic while enabled,
            including after unlock and during its grace period. Generic scheduled reminders remain
            scheduled; unsafe legacy alarms are removed. Secure Screen alone does not change
            notification previews.
          </Text>
        </SettingsSection>

        <SettingsSection label="ENCRYPTED DATABASE" style={styles.gap}>
          <Text style={textStyle}>
            Messages, contacts, drafts, reminders, and most non-secret preferences are stored in a
            SQLCipher-encrypted database. Server credentials, the database key, the authoritative
            App Lock setting, and a small set of boot-time secrets are kept separately in Android
            secure storage. Android also keeps ordinary app-private on/off mirrors for App Lock’s
            pre-JavaScript Recents policy and Secure Screen; those mirrors contain no message
            content or credentials. App Lock does not make the database key biometric-bound.
          </Text>
        </SettingsSection>

        <SettingsSection label="FILES OUTSIDE THE DATABASE" style={styles.gap}>
          <Text style={textStyle}>
            Downloaded or staged attachments, chat wallpapers and synced backgrounds, cached contact
            images, app logs, legacy incoming-share copies, and image or other Android/Expo-managed
            caches are ordinary files. Android keeps them in Gator’s app-private folders, so normal
            apps cannot browse them, but SQLCipher and App Lock do not encrypt those files.
          </Text>
          <Text style={textStyle}>
            Android and bundled SDKs also keep ordinary app-private operational preferences and
            databases for permissions, background tasks, media and web-view state, notifications,
            and scheduling. SQLCipher does not protect those files. Firebase stores installation
            identifiers and tokens, including the FCM registration token, in ordinary app-private
            files. Disconnect asks Firebase to delete the registration token, but Android/Firebase
            operational metadata may remain until you clear app data or uninstall. Gator also keeps
            a non-secret, zero-byte account-revocation marker after Disconnect until a replacement
            account fully activates.
          </Text>
          <Text style={textStyle}>
            Attachments you save to Photos—and images automatically exported to Photos or the Gator
            album when that setting is enabled—are separate copies in Android’s shared media
            storage. Other apps with media access can see them. If an image delivered while Gator is
            closed or in the background finishes downloading, that download is only in Gator’s
            private cache. Gator keeps a bounded encrypted record of the queued outside copy and
            retries it on a later foreground activation when the app is unlocked and already has
            Photos permission. Turning off auto-download or changing its save destination cancels
            queued copies that have not started; a copy Android is already saving may still finish.
            A process stop immediately after Android saves a copy can cause a later retry to create
            a duplicate, but Gator caps attempts at three.
          </Text>
        </SettingsSection>

        <SettingsSection label="CLEANUP" style={styles.gap}>
          {downloadsPaused ? (
            <>
              <Text style={textStyle}>
                New downloads are paused because Gator couldn’t finish checking the attachments it
                has already downloaded, usually because an older version kept more than it can
                check. Repair Downloads removes the oldest ones beyond the limits below so the check
                can finish.
              </Text>
              <NavRow
                label={
                  repairChecked === null
                    ? 'Repair Downloads'
                    : `Repairing… ${repairChecked.toLocaleString()} checked`
                }
                onPress={confirmRepair}
                chevron={false}
                disabled={repairChecked !== null}
              />
            </>
          ) : null}
          <Text style={textStyle}>
            Gator limits its ordinary downloaded-attachment cache to 2 GiB and 4,096 files while
            preserving at least 512 MiB of free app storage. A download also needs room for its own
            size, or up to 512 MiB when the server does not report one. It removes the least
            recently used old files first. Files currently on screen, used by an in-progress
            operation, needed for an outgoing send, or awaiting an automatic Photos copy are
            protected; a new download is refused when space cannot be freed safely. This release
            requires Android 16 or newer; older Android versions cannot install it.
          </Text>
          <Text style={textStyle}>
            Deleting a chat removes Gator-owned downloaded files after its database purge when
            possible. Disconnecting clears the account’s database contents, attachments, contact
            images, wallpapers, custom folder names and memberships, and app logs before another
            account can connect. If required cleanup cannot be confirmed, Gator blocks the next
            connection so the cleanup can be retried. It does not delete copies exported to Photos
            or the Gator album; remove those in your Photos app. Temporary cache files may remain
            until Gator or Android removes them. Clear App Logs deletes the saved log and tells you
            if Android cannot confirm removal. Release builds retain structured error diagnostics,
            including an opaque crash-site code without a filename, function name, or original
            stack, plus a small push-receipt record containing a minute-rounded receipt time, the
            server event category, and whether delivery was foreground or background. Development
            builds may keep extra local diagnostics, but Share diagnostics exports only the
            structured errors and finite receipt events. Clearing app data or uninstalling removes
            Gator’s app-private files but not exported media copies.
          </Text>
        </SettingsSection>

        <SettingsSection label="BACKUPS" style={styles.gap}>
          <Text style={textStyle}>
            A backup contains your theme, selected app settings, per-chat customizations,
            device-owned contact colors, and custom folder names, order, unread-badge choices, and
            portable conversation identities. Folder and color identities can include participant
            phone numbers or email addresses. It does not contain messages, drafts, unread state,
            diagnostic consent, files, or credentials. Unavailable or ambiguous folder members are
            skipped and reported rather than guessed. Same-name folders merge without removing local
            members; only newly created folders use the saved order.
          </Text>
          <Text style={textStyle}>
            Gator encrypts a new backup before writing a temporary share file or sending ciphertext
            to a server backup slot. It attempts to delete the temporary file after the share sheet
            closes. Copies saved to Files, Drive, other apps, or server slots remain until you
            delete them; disconnecting does not remove those copies. Gator can still import older
            plaintext backup files but no longer has a plaintext export path.
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
