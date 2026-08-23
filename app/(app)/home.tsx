import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';
import { disconnectFailureMessage, forget, http } from '@/services';
import { getDatabase } from '@db/database';
import { showDialog } from '@ui/dialog/dialogStore';
import { fireDueScheduled, recoverOutgoing, runDueScheduled } from '@/services/send';
import {
  devInjectIncomingFaceTime,
  devQueueIncomingMessageWithoutDrain,
  devResumeQueuedIncomingMessages,
  devSendFake,
  devSendFakeReply,
  injectMessage,
} from '@features/conversations/devSeed';
import { hydrateAllStores } from '@state/hydrateStores';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { isDevServer } from '@utils/isDev';
import { ConversationListScreen } from '@ui';

/**
 * The connected inbox. Renders the reactive conversation list; a DEV-only
 * overlay drives on-device verification (inject a live message, disconnect).
 */
export default function Home(): React.JSX.Element {
  const router = useRouter();
  const showDevProofControls = __DEV__ && isDevServer();
  // One lease for this exact mounted inbox. A delayed continuation from account A must not call a
  // service after reconnect and let that service capture account B's otherwise-valid generation.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());

  // Catch up on any scheduled messages that came due while the app was away. Every scheduled
  // runner now performs the crash-row recovery itself, through one shared account-generation gate.
  useEffect(() => {
    const useDevFixtures = isDevServer();
    // The DB is open by the time the inbox mounts; re-hydrate the kv-backed prefs
    // stores that the root layout's pre-connect pass silently skipped (e.g. the theme
    // preset — see src/state/themeStore.ts and src/state/hydrateStores.ts).
    // The stores predate account leases and commit their in-memory values after DB reads. Publish
    // this short, bounded read as teardown work so Disconnect cannot wipe A, admit B, and then let
    // a late A hydrate overwrite B's live settings.
    void runTrackedRealtimeWork(accountLease, () =>
      hydrateAllStores({ shouldCommit: () => accountLease.isCurrent() }),
    ).catch((error: unknown) => {
      if (accountLease.isCurrent()) logger.debug('[home] preference hydration failed', error);
    });
    void (async () => {
      try {
        if (!accountLease.isCurrent()) return;
        if (useDevFixtures) {
          await devResumeQueuedIncomingMessages(accountLease);
          if (!accountLease.isCurrent()) return;
        }
        // Retry any stranded/failed optimistic sends from a prior session (skip in dev
        // where sends are faked locally and there's no real server to POST to).
        if (!useDevFixtures) {
          await recoverOutgoing();
          if (!accountLease.isCurrent()) return;
        }
        if (useDevFixtures) {
          // Unlike fireDueScheduled(), this injected DEV path does not own a coordinator slot.
          // Track it here and pass the mount lease into its DB guards.
          await runTrackedRealtimeWork(accountLease, () =>
            runDueScheduled(
              getDatabase(),
              http,
              Date.now(),
              (g, t, s) =>
                s
                  ? devSendFakeReply(g, t, s, undefined, accountLease)
                  : devSendFake(g, t, undefined, accountLease),
              accountLease,
            ),
          );
        } else {
          await fireDueScheduled();
        }
      } catch (e) {
        // Best-effort catch-up; never crash the inbox if a due send fails.
        if (accountLease.isCurrent()) logger.debug('[home] scheduled catch-up failed', e);
      }
    })();
  }, [accountLease]);

  const runDevAccountAction = (
    label: string,
    action: (lease: RealtimeDeliveryLease) => Promise<unknown>,
  ): void => {
    // DevPush does not carry the FCM/socket delivery context. Keeping this small local action in
    // the teardown set ensures its DB/store result lands before A is wiped, never after B starts.
    void runTrackedRealtimeWork(accountLease, () => action(accountLease)).catch(
      (error: unknown) => {
        if (accountLease.isCurrent()) {
          logger.warn(`[home] DEV ${label} failed`, {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      },
    );
  };

  const onDisconnect = async (): Promise<void> => {
    // A retained button callback from an unmounted A inbox must never disconnect B. Do NOT put
    // forget() in runTrackedRealtimeWork: forget owns and waits for that very barrier.
    if (!accountLease.isCurrent()) return;
    try {
      await forget();
    } catch (e) {
      logger.warn('[home] Disconnect cleanup remains incomplete', e);
      showDialog('Disconnect incomplete', disconnectFailureMessage(e));
    } finally {
      router.replace('/welcome');
    }
  };

  return (
    <View style={styles.flex}>
      <ConversationListScreen />
      {__DEV__ ? (
        <View style={styles.devBar} pointerEvents="box-none">
          <View style={styles.devRow}>
            <Pressable
              style={[styles.devBtn, styles.devFlex]}
              onPress={() => runDevAccountAction('message injection', injectMessage)}
            >
              <Text style={styles.devText}>⚡ Inject</Text>
            </Pressable>
            {showDevProofControls ? (
              <Pressable
                style={[styles.devBtn, styles.devFlex]}
                onPress={() =>
                  runDevAccountAction(
                    'persist-without-drain proof',
                    devQueueIncomingMessageWithoutDrain,
                  )
                }
              >
                <Text style={styles.devText}>⏸ Queue</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.devBtn, styles.devFlex]}
              onPress={() => runDevAccountAction('FaceTime injection', devInjectIncomingFaceTime)}
            >
              <Text style={styles.devText}>📞 FaceTime</Text>
            </Pressable>
            <Pressable
              style={[styles.devBtn, styles.devFlex]}
              onPress={() => {
                if (accountLease.isCurrent()) router.push('/findmy');
              }}
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
