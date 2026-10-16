import { ExperimentalStack, Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState as NativeAppState, StyleSheet, View, type AppStateStatus } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { isLockExpired } from '@core/security/lockTimeout';
import { logger as secureLogger } from '@core/secure';
import {
  handleNotificationAction,
  handleNotificationPress,
} from '@/services/notifications/actions';
import {
  EventType,
  nativeNotificationAdapter as notifee,
} from '@/services/notifications/nativeNotificationAdapter';
import { reconcileMessageNotificationGroupAfterRemoval } from '@/services/notifications/notifeeService';
import {
  drainNotificationTap,
  openNotificationPress,
} from '@/services/notifications/notificationOpen';
import {
  reserveNotificationTap,
  takePendingNotification,
} from '@/services/notifications/pendingNav';
import {
  flushErrorReports,
  pauseRealtime,
  resumeRealtime,
  retryRealtimeConnection,
} from '@/services';
import { recoverOutgoing } from '@/services/send';
import { drainPendingAttachmentMediaExports } from '@/services/download/attachmentMediaExportQueue';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { isDevServer } from '@utils/isDev';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { ConnectionBanner } from '@ui/connection';
import { ServerRotationApprovalHost } from '@ui/server-rotation';
import { ShareIntentNavigator } from '@ui/ShareIntentHandler';
import { useChatNavigator } from '@ui/useChatNavigator';
import { completeNativeForegroundPrivacyTransition } from '@native/screenSecurity';

/** Catch every intentionally fire-and-forget notification task without logging payload content. */
function runNotificationTask(
  label: string,
  accountLease: RealtimeDeliveryLease,
  task: () => Promise<unknown>,
): void {
  void Promise.resolve()
    .then(() => (accountLease.isCurrent() ? task() : undefined))
    .catch((error: unknown) => {
      if (!accountLease.isCurrent()) return;
      secureLogger.warn('[notif] foreground notification task failed', {
        task: label,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
}

/** Account-owned foreground retry; coalesced inside the queue service per generation. */
function runAttachmentMediaExportDrain(accountLease: RealtimeDeliveryLease): void {
  if (!accountLease.isCurrent()) return;
  void drainPendingAttachmentMediaExports(accountLease).catch((error: unknown) => {
    if (accountLease.isCurrent()) {
      secureLogger.warn('[mediaExport] foreground retry failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  });
}

/** Keep an unregistered native AppState callback from being replayed under a replacement account. */
function createAccountOwnedAppState(
  accountLease: RealtimeDeliveryLease,
): Pick<typeof NativeAppState, 'addEventListener'> {
  return {
    addEventListener: (type, listener) =>
      NativeAppState.addEventListener(type, (state) => {
        if (accountLease.isCurrent()) listener(state);
      }),
  };
}

/**
 * Layout for the connected app. Drives the resume re-lock (the gate itself is
 * rendered as an overlay in the root layout) and handles foreground notification
 * actions (reply / mark-read).
 */
export default function AppLayout(): React.JSX.Element {
  const status = useSessionStore((s) => s.status);
  const hasSession = useSessionStore((s) => !!(s.origin && s.password));

  // A killed-app notification/deep link can mount this route before boot has read SecureStore.
  // Keep the route inert while that decision is pending; redirecting now would strand a valid
  // saved session on the setup screen just because the vault read had not finished yet.
  if (status === 'loading') return <></>;

  // Disconnect resets the session before its first asynchronous cleanup step. Keep the connected
  // route group equally synchronous: screens already on the stack must stop rendering and must not
  // run their resume/retry effects while the residual wipe continues behind the setup screen.
  if (!hasSession) return <Redirect href="/welcome" />;

  return <ConnectedAppLayout />;
}

function ConnectedAppLayout(): React.JSX.Element {
  const router = useRouter();
  // Opens a chat WITHOUT stacking one thread on another: a notification tapped while a thread is
  // already open swaps it (replace) instead of pushing, so Back from any thread → Messages.
  const openChat = useChatNavigator();
  // A group-summary tap is not a chat transition. Pop to the existing inbox (or replace only when
  // it is absent) so a tap from inside a thread cannot leave duplicate Home screens in the stack.
  const openInbox = useCallback(() => router.dismissTo('/home'), [router]);
  // Every listener/effect below belongs to this mounted account. Native/AppState callbacks may be
  // queued past unmount, so they must not capture the replacement account when they finally run.
  const [accountLease] = useState(captureRealtimeDeliveryLease);
  const [connectionBannerHeight, setConnectionBannerHeight] = useState(0);
  const physicalInsets = useSafeAreaInsets();
  // Reserve banner space in route headers, not around the navigator: moving a nested
  // KeyboardAvoidingView changes its local origin while Android reports screen coordinates.
  const contentInsets = useMemo(
    () => ({ ...physicalInsets, top: physicalInsets.top + connectionBannerHeight }),
    [physicalInsets, connectionBannerHeight],
  );
  const [AppState] = useState(() => createAccountOwnedAppState(accountLease));
  // Preserve the exact certified AppState orchestration callback while making its asynchronous
  // catch handlers obey the same mount lease as callback entry.
  const [leaseLogger] = useState(() => ({
    warn: (message: string, meta?: unknown): void => {
      if (accountLease.isCurrent()) secureLogger.warn(message, meta);
    },
  }));

  // Coordinate App Lock and realtime in ONE listener. Two separate listeners introduced a race:
  // the first locked the UI after a long background interval, then the second immediately
  // reconnected the socket and posted full-content notifications underneath the lock overlay.
  // Here the lock decision is made before any resume work, and unlock explicitly resumes later.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const lock = useLockStore.getState();
      if (state === 'background' || state === 'inactive') {
        if (lock.enabled) lock.noteBackgrounded(Date.now());
        pauseRealtime();
        void flushErrorReports();
        return;
      }
      if (state === 'active') {
        if (
          lock.enabled &&
          (lock.locked || isLockExpired(lock.lastBackgrounded, Date.now(), lock.timeoutMs))
        ) {
          lock.lock();
          pauseRealtime();
          return;
        }
        // The resume is accepted inside the grace period, so the background interval is over.
        // Without this, every later effectivelyLocked() check (live intake, realtime recovery) would
        // see the old timestamp expire ~timeout after the user LEFT and silently reject events while
        // the app is open and unlocked.
        lock.noteForegrounded();
        // Android 12 and older use a transient secure-window fallback for App Lock Recents. Keep
        // it through native resume until this exact grace-period decision says content may show.
        completeNativeForegroundPrivacyTransition();
        void resumeRealtime().catch((error: unknown) => {
          leaseLogger.warn('[realtime] foreground resume failed', error);
        });
        void flushErrorReports();
        // Drain the outgoing retry queue on resume — a send that failed mid-session otherwise
        // waits for the next home mount / 15-min background tick. Backoff + claims gate the
        // actual re-sends, so this is one cheap SELECT when nothing is pending.
        if (!isDevServer()) {
          void recoverOutgoing().catch((error: unknown) => {
            leaseLogger.warn('[send] foreground recovery failed', error);
          });
        }
        runAttachmentMediaExportDrain(accountLease);
      }
    });
    return () => sub.remove();
  }, [AppState, accountLease, leaseLogger]);

  // Cold foreground mount and post-unlock remount do not necessarily emit a new AppState event.
  useEffect(() => {
    runAttachmentMediaExportDrain(accountLease);
  }, [accountLease]);

  // Upload any buffered error reports once the connected app has mounted ("on start"). No-op unless
  // the server advertises support + the feature is enabled; the AppState listener above catches up
  // if serverInfo hasn't loaded yet at mount.
  useEffect(() => {
    void flushErrorReports();
  }, []);

  // Drain a pending notification tap and open its chat. Reads BOTH the notify-kit launch event
  // (getInitialNotification) and the pendingNav stash a background-alive tap leaves behind, once.
  const consumeNotificationTap = useCallback(() => {
    runNotificationTask('tap-drain', accountLease, () =>
      drainNotificationTap(
        () => notifee.getInitialNotification(),
        takePendingNotification,
        handleNotificationPress,
        { openChat, openInbox },
        undefined,
        accountLease,
      ),
    );
  }, [accountLease, openChat, openInbox]);

  // Foreground notification handling. Action buttons (reply / mark-read / love) run their
  // side-effects; a body tap (PRESS) while the app is VISIBLE runs its side-effects AND deep-links
  // to the chat, scrolling to the message. On Android `launchActivity: 'default'` only foregrounds
  // the app — it does NOT navigate — so we route the tap here.
  useEffect(
    () =>
      notifee.onForegroundEvent(({ type, detail }) => {
        if (!accountLease.isCurrent()) return;
        if (type === EventType.ACTION_PRESS) {
          runNotificationTask('action', accountLease, () => handleNotificationAction(detail));
        } else if (type === EventType.PRESS) {
          // Reserve at native callback entry, not in the queued task: a newer physical press must
          // fence an older DB lookup before that lookup's already-queued continuation can navigate.
          const tap = reserveNotificationTap(detail, accountLease);
          runNotificationTask('press-side-effect', accountLease, () =>
            handleNotificationPress(detail),
          );
          if (tap) {
            runNotificationTask('press-navigation', accountLease, () =>
              openNotificationPress(detail, { openChat, openInbox }, accountLease),
            );
          }
          runNotificationTask('message-group-press', accountLease, () =>
            reconcileMessageNotificationGroupAfterRemoval(detail.notification),
          );
        } else if (type === EventType.DISMISSED) {
          runNotificationTask('message-group-dismiss', accountLease, () =>
            reconcileMessageNotificationGroupAfterRemoval(detail.notification),
          );
        }
      }),
    [accountLease, openChat, openInbox],
  );

  // Cold start: a tap that LAUNCHED the app from killed isn't replayed as a foreground event —
  // getInitialNotification() reports it once, drained here on mount.
  useEffect(() => {
    consumeNotificationTap();
  }, [consumeNotificationTap]);

  // Resume: a tap while the app was ALIVE-BUT-BACKGROUNDED is delivered to the headless
  // onBackgroundEvent (which can't navigate), NOT to onForegroundEvent above — this is the common
  // case and the reason taps used to just foreground the app on its last screen. Drain the pending
  // tap when we come active so the chat actually opens. (Kept separate from the app-lock / realtime
  // AppState listeners; drainNotificationTap is a no-op when there's nothing pending.)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') consumeNotificationTap();
    });
    return () => sub.remove();
  }, [AppState, consumeNotificationTap]);

  return (
    <View style={styles.root}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        <ExperimentalStack screenOptions={{ headerShown: false }} />
      </SafeAreaInsetsContext.Provider>
      <ShareIntentNavigator />
      <ConnectionBanner
        onRetry={retryRealtimeConnection}
        onManageServer={() => router.navigate('/server-management')}
        onHeightChange={setConnectionBannerHeight}
      />
      <ServerRotationApprovalHost />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
