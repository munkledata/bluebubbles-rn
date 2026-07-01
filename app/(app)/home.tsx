import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';
import { forget, http } from '@/services';
import { getDatabase } from '@db/database';
import {
  fireDueScheduled,
  recoverOutgoing,
  recoverStuckScheduled,
  runDueScheduled,
} from '@/services/send';
import {
  devInjectIncomingFaceTime,
  devSendFake,
  devSendFakeReply,
  injectMessage,
} from '@features/conversations/devSeed';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { isDevServer } from '@utils/isDev';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useDownloadSettingsStore } from '@state/downloadSettingsStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { ConversationListScreen } from '@ui';

/**
 * The connected inbox. Renders the reactive conversation list; a DEV-only
 * overlay drives on-device verification (inject a live message, disconnect).
 */
export default function Home(): React.JSX.Element {
  const router = useRouter();

  // Catch up on any scheduled messages that came due while the app was away —
  // after first recovering rows interrupted mid-send by a prior crash/kill.
  useEffect(() => {
    const isDev = isDevServer;
    // The DB is open by the time the inbox mounts; (re)hydrate prefs that the
    // root layout may have skipped pre-connect.
    void useSmartReplyStore.getState().hydrate();
    void useRedactedModeStore.getState().hydrate();
    void useDownloadSettingsStore.getState().hydrate();
    void useFeatureSettingsStore.getState().hydrate();
    void useSyncSettingsStore.getState().hydrate();
    void (async () => {
      try {
        await recoverStuckScheduled();
        // Retry any stranded/failed optimistic sends from a prior session (skip in dev
        // where sends are faked locally and there's no real server to POST to).
        if (!isDev()) await recoverOutgoing();
        if (isDev()) {
          await runDueScheduled(getDatabase(), http, Date.now(), (g, t, s) =>
            s ? devSendFakeReply(g, t, s) : devSendFake(g, t),
          );
        } else {
          await fireDueScheduled();
        }
      } catch (e) {
        // Best-effort catch-up; never crash the inbox if a due send fails.
        logger.debug('[home] scheduled catch-up failed', e);
      }
    })();
  }, []);

  const onDisconnect = async (): Promise<void> => {
    await forget();
    router.replace('/welcome');
  };

  return (
    <View style={styles.flex}>
      <ConversationListScreen />
      {__DEV__ ? (
        <View style={styles.devBar} pointerEvents="box-none">
          <View style={styles.devRow}>
            <Pressable style={[styles.devBtn, styles.devFlex]} onPress={() => void injectMessage()}>
              <Text style={styles.devText}>⚡ Inject</Text>
            </Pressable>
            <Pressable
              style={[styles.devBtn, styles.devFlex]}
              onPress={() => void devInjectIncomingFaceTime()}
            >
              <Text style={styles.devText}>📞 FaceTime</Text>
            </Pressable>
            <Pressable
              style={[styles.devBtn, styles.devFlex]}
              onPress={() => router.push('/findmy')}
            >
              <Text style={styles.devText}>📍 Find My</Text>
            </Pressable>
          </View>
          <Pressable style={[styles.devBtn, styles.devDanger]} onPress={onDisconnect}>
            <Text style={styles.devText}>Disconnect</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  devBar: { position: 'absolute', bottom: 24, left: 16, right: 16, gap: 10 },
  devRow: { flexDirection: 'row', gap: 8 },
  devFlex: { flex: 1 },
  devBtn: {
    backgroundColor: '#1982FCee',
    paddingHorizontal: 14,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  devDanger: { backgroundColor: '#FF3B30ee' },
  devText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
