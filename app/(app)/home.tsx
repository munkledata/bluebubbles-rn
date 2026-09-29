import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@core/secure';
import { runDevPerf02InboxBenchmark } from '@/services';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  fireDueScheduled,
  fireDueScheduledWithDevelopmentSender,
  recoverOutgoing,
} from '@/services/send';
import {
  devQueueIncomingMessageWithoutDrain,
  devResumeQueuedIncomingMessages,
  devSendFake,
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
 * footer drives on-device verification without covering the inbox controls.
 */
export default function Home(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const showDevProofControls = __DEV__ && isDevServer();
  // One lease for this exact mounted inbox. A delayed continuation from account A must not call a
  // service after reconnect and let that service capture account B's otherwise-valid generation.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

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
          await fireDueScheduledWithDevelopmentSender(
            (guid, text, selectedMessageGuid, onQueued) => {
              if (selectedMessageGuid) {
                return Promise.reject(new Error('Scheduled replies were retired in this release.'));
              }
              return devSendFake(guid, text, undefined, accountLease, onQueued);
            },
            accountLease,
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

  const onBenchmark = (): void => {
    if (!__DEV__ || benchmarkBusy) return;
    setBenchmarkBusy(true);
    void runDevPerf02InboxBenchmark()
      .then((results) => {
        if (!accountLease.isCurrent()) return;
        const summary = results
          .map(
            (result) =>
              `${result.chats.toLocaleString()} chats: page p95 ${result.page.p95Ms} ms, indexed search p95 ${result.indexedSearch.p95Ms} ms`,
          )
          .join('\n');
        showDialog('PERF-02 Android query measurement', summary);
      })
      .catch((error: unknown) => {
        logger.warn('[home] DEV PERF-02 benchmark failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        if (accountLease.isCurrent()) {
          showDialog(
            'PERF-02 benchmark failed',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
      })
      .finally(() => setBenchmarkBusy(false));
  };

  return (
    <View style={styles.flex}>
      <ConversationListScreen />
      {__DEV__ ? (
        <View
          style={[styles.devBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
          pointerEvents="box-none"
          testID="home-dev-tools-footer"
        >
          {devToolsOpen ? (
            <View style={styles.devPanel}>
              <Pressable
                style={[styles.devBtn, styles.devClose]}
                onPress={() => setDevToolsOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close developer tools"
              >
                <Text style={styles.devText}>Hide DEV tools</Text>
              </Pressable>
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
                  onPress={() => {
                    if (accountLease.isCurrent()) router.push('/findmy');
                  }}
                >
                  <Text style={styles.devText}>📍 Find My</Text>
                </Pressable>
              </View>
              <Pressable
                style={styles.devBtn}
                onPress={() => router.push('/perf-inbox')}
                disabled={benchmarkBusy}
              >
                <Text style={styles.devText}>📊 Measure rendered inbox</Text>
              </Pressable>
              <Pressable style={styles.devBtn} onPress={onBenchmark} disabled={benchmarkBusy}>
                <Text style={styles.devText}>
                  {benchmarkBusy ? '📈 Measuring disposable inbox…' : '📈 Measure PERF-02 queries'}
                </Text>
              </Pressable>
              <Pressable
                style={styles.devBtn}
                onPress={() => router.push('/perf-inbox-cold')}
                disabled={benchmarkBusy}
              >
                <Text style={styles.devText}>❄️ Measure cold inbox</Text>
              </Pressable>
              <Pressable
                style={styles.devBtn}
                onPress={() => {
                  if (accountLease.isCurrent()) router.push('/settings');
                }}
                accessibilityRole="button"
                accessibilityLabel="Manage connection in Settings"
              >
                <Text style={styles.devText}>Manage connection</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.devToggle}
              onPress={() => setDevToolsOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Open developer tools"
            >
              <Text style={styles.devText}>DEV</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  devBar: { flexShrink: 0, paddingHorizontal: 16, paddingTop: 8 },
  devPanel: { gap: 10 },
  devRow: { flexDirection: 'row', gap: 8 },
  devFlex: { flex: 1 },
  devBtn: {
    backgroundColor: '#1982FCee',
    paddingHorizontal: 14,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  devToggle: {
    alignSelf: 'flex-start',
    backgroundColor: '#1982FCee',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  devClose: { backgroundColor: '#3A3A3Cee' },
  devText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
