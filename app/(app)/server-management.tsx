import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { showConfirm, showDialog } from '@ui/dialog/dialogStore';
import { serverApi } from '@core/api';
import { isUnimplementedEndpoint } from '@core/api/errors';
import { isScopedDeviceCredential } from '@core/secure';
import { buildSetupQr } from '@features/setup/qr';
import {
  beginScopedCredentialReplacement,
  beginScopedCredentialUpgrade,
  cancelFullRepair,
  discardScopedCredentialUpgradeCandidate,
  http,
  inspectScopedCredentialUpgradeStatus,
  startFullRepair,
  startSync,
} from '@/services';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  captureSessionTransportLease,
  type SessionTransportLease,
  useSessionStore,
} from '@state/sessionStore';
import { useSyncStore, type SyncRepairStatus } from '@state/syncStore';
import { InfoRow, PairingQr, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

/**
 * Read-only queries do not hold Disconnect open. Their account-generation and transport-revision
 * cache keys isolate the eventual TanStack Query commit; this guard also turns a late result/error
 * from a retired account or server URL into null.
 */
async function readForTransport<T>(
  accountLease: RealtimeDeliveryLease,
  expectedTransportRevision: number,
  read: (transportLease: SessionTransportLease) => Promise<T>,
): Promise<T | null> {
  if (!accountLease.isCurrent()) return null;
  const transportLease = captureSessionTransportLease();
  if (transportLease.revision !== expectedTransportRevision || !transportLease.isCurrent()) {
    return null;
  }
  try {
    const value = await read(transportLease);
    return accountLease.isCurrent() && transportLease.isCurrent() ? value : null;
  } catch (error) {
    if (!accountLease.isCurrent() || !transportLease.isCurrent()) return null;
    throw error;
  }
}

type ModalAnimationType = 'none' | 'slide';

function useReduceMotionPreferenceRef(): React.RefObject<boolean | null> {
  const reduceMotion = useRef<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    let receivedPreferenceEvent = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      receivedPreferenceEvent = true;
      if (mounted) reduceMotion.current = enabled;
    });

    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (mounted && !receivedPreferenceEvent) reduceMotion.current = enabled;
      },
      () => {
        // If the native query is unavailable, retain the existing slide behavior for future opens.
        if (mounted && !receivedPreferenceEvent) reduceMotion.current = false;
      },
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

function modalAnimationFor(reduceMotion: boolean | null): ModalAnimationType {
  return reduceMotion === false ? 'slide' : 'none';
}

function repairStatusCopy(status: SyncRepairStatus, phase: string | null): string {
  if (status === 'idle') return 'Not run';
  if (status === 'queued') return phase ?? 'Waiting';
  if (status === 'running') return phase ?? 'Running';
  if (status === 'cancelling') return 'Stopping after current request';
  if (status === 'cancelled') return 'Stopped — safe to restart';
  if (status === 'done') return phase ?? 'Complete';
  return 'Failed — safe to restart';
}

function iMessageAvailabilityCopy(supported: boolean | null | undefined): string {
  if (supported === true) return 'Read-only lookup available';
  if (supported === false) return 'Not available';
  return 'Unknown';
}

/** Server status, local-cache maintenance, pairing, sync, and read-only statistics. */
export default function ServerManagementScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const reduceMotion = useReduceMotionPreferenceRef();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const setServerInfoForTransport = useSessionStore((s) => s.setServerInfoForTransport);
  const origin = useSessionStore((s) => s.origin);
  const password = useSessionStore((s) => s.password);
  const transportRevision = useSessionStore((s) => s.transportRevision);
  const syncStatus = useSyncStore((s) => s.status);
  // Select each primitive separately — an object-returning selector `(s) => ({...})` allocates a
  // fresh object every render, which useSyncExternalStore reads as a changed snapshot → infinite
  // re-render loop ("Maximum update depth exceeded"). zustand has no auto-shallow-compare.
  const syncChats = useSyncStore((s) => s.chats);
  const syncMessages = useSyncStore((s) => s.messages);
  const repairStatus = useSyncStore((s) => s.repairStatus);
  const repairPhase = useSyncStore((s) => s.repairPhase);
  const repairLog = useSyncStore((s) => s.repairLog);
  // Every query/callback created by this screen belongs to the account that mounted it. A global
  // confirm dialog can retain its button callback after navigation, so checking only mounted state
  // is insufficient.
  const accountLease = useScreenAccountLease();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());

  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [qrModal, setQrModal] = useState<ModalAnimationType | null>(null);
  const [credentialModal, setCredentialModal] = useState<ModalAnimationType | null>(null);
  const [credentialText, setCredentialText] = useState('');
  const [credentialIssue, setCredentialIssue] = useState<string | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [credentialDiscardable, setCredentialDiscardable] = useState(false);
  const [credentialWorking, setCredentialWorking] = useState(false);

  // The lease revokes callbacks synchronously, but currentness is not reactive. Force an old
  // mounted route to unmount credential/log subtrees as soon as its account generation retires.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
        setQrModal(null);
        setCredentialModal(null);
        setCredentialText('');
        setCredentialIssue(null);
        setCredentialSaved(false);
        setCredentialDiscardable(false);
        setCredentialWorking(false);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const legacyCredentialSession =
    accountCurrent && !!password && !isScopedDeviceCredential(password);
  const scopedCredentialSession =
    accountCurrent && !!password && isScopedDeviceCredential(password);
  const canManageCredential = legacyCredentialSession || scopedCredentialSession;

  // The journal, rather than component memory, owns retry visibility. This makes a candidate
  // created before process death immediately visible and discardable without pasting it again.
  useEffect(() => {
    let current = true;
    if (!canManageCredential) {
      return () => {
        current = false;
      };
    }
    void inspectScopedCredentialUpgradeStatus().then((status) => {
      if (
        !current ||
        !accountLease.isCurrent() ||
        useSessionStore.getState().transportRevision !== transportRevision
      ) {
        return;
      }
      setCredentialSaved(status.kind === 'candidate' || status.kind === 'in-progress');
      setCredentialDiscardable(status.kind === 'candidate');
    });
    return () => {
      current = false;
    };
  }, [accountLease, canManageCredential, transportRevision]);

  // A legacy pairing payload embeds the shared password. A scoped credential belongs to this
  // device alone, so never offer it as a reusable QR or hand it to the QR subtree at all.
  let pairingPayload: string | null = null;
  if (accountCurrent && origin && password && !isScopedDeviceCredential(password)) {
    try {
      pairingPayload = buildSetupQr(origin, password);
    } catch {
      pairingPayload = null; // A malformed origin leaves the sharing action unavailable.
    }
  }

  // Round-trip latency probe. `retry: false` mirrors the endpoint's fail-fast intent — a
  // reachability check must not mask a down server by silently retrying, and
  // `staleTime: 0` makes every visit re-probe instead of showing a cached answer.
  const pingQuery = useQuery({
    queryKey: ['server', 'ping', accountLease.generation, transportRevision],
    queryFn: ({ signal }) =>
      readForTransport(accountLease, transportRevision, async () => {
        const t0 = Date.now();
        await serverApi.ping(http, signal);
        return Date.now() - t0;
      }),
    retry: false,
    staleTime: 0,
  });
  const latency = accountLease.isCurrent() ? (pingQuery.data ?? null) : null;
  const reachable = !accountLease.isCurrent()
    ? null
    : pingQuery.isSuccess && pingQuery.data != null
      ? true
      : pingQuery.isError
        ? false
        : null;

  // Statistics use the typed password-authenticated snapshot route. A total failure is shown
  // inline rather than as a modal interruption.
  const statsQuery = useQuery({
    queryKey: ['server', 'stats', accountLease.generation, transportRevision],
    enabled: legacyCredentialSession,
    queryFn: ({ signal }) =>
      readForTransport(accountLease, transportRevision, () =>
        serverApi.serverStatTotals(http, signal),
      ),
  });
  const totals = legacyCredentialSession ? (statsQuery.data ?? null) : null;
  const statsError = legacyCredentialSession && statsQuery.isError;
  // A missing typed route is surfaced as unsupported rather than as a connection failure.
  const statsUnsupported = statsError && isUnimplementedEndpoint(statsQuery.error);

  // Refresh the cached server info (version / macOS / current capabilities). On a hydrated boot the
  // `connected` action never ran, so the session store still has serverInfo=null → "Unknown";
  // fetching it here populates the STATUS section and the independent RCS capability gate.
  const infoQuery = useQuery({
    queryKey: ['server', 'info', accountLease.generation, transportRevision],
    queryFn: ({ signal }) =>
      readForTransport(accountLease, transportRevision, async (requestTransport) => {
        const info = await serverApi.serverInfo(http, signal);
        return {
          info,
          origin: requestTransport.origin,
          revision: requestTransport.revision,
        };
      }),
  });
  const latestServerInfo = infoQuery.data;
  useEffect(() => {
    if (!latestServerInfo?.origin || !accountLease.isCurrent()) return;
    setServerInfoForTransport(
      latestServerInfo.origin,
      latestServerInfo.revision,
      latestServerInfo.info,
    );
  }, [accountLease, latestServerInfo, setServerInfoForTransport]);

  const onLoadStats = (): void => {
    if (busy || !legacyCredentialSession) return;
    setBusy('Load Stats');
    // `refetch` never rejects — success/failure land in `statsQuery.data` / `.isError`.
    void statsQuery.refetch().finally(() => {
      if (accountLease.isCurrent()) setBusy(null);
    });
  };

  const onSyncNow = (): void => {
    if (busy || syncStatus === 'syncing' || !accountLease.isCurrent()) return;
    void startSync();
  };

  const repairActive =
    repairStatus === 'queued' || repairStatus === 'running' || repairStatus === 'cancelling';

  const onStartRepair = (): void => {
    if (busy || repairActive || !accountLease.isCurrent()) return;
    const restarting = repairStatus === 'cancelled' || repairStatus === 'error';
    showDialog(
      restarting ? 'Restart Local Cache Repair' : 'Repair Local Cache',
      'Re-download every chat and message from your server without disconnecting. Pins, custom names, wallpapers, themes, reminders, drafts, and deleted-chat protections stay in place. This can take a while.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: restarting ? 'Restart Repair' : 'Start Repair',
          onPress: () => {
            if (accountLease.isCurrent()) void startFullRepair();
          },
        },
      ],
    );
  };

  const onCancelRepair = (): void => {
    if (!accountLease.isCurrent() || repairStatus === 'cancelling') return;
    cancelFullRepair();
  };

  // Format a stat with thousands separators; em-dash until stats have loaded.
  const statVal = (n?: number): string => (totals ? (n ?? 0).toLocaleString() : '—');

  // Share the server URL (the share sheet includes Copy) — avoids a clipboard native dep.
  const onShareUrl = (): void => {
    if (!origin || !accountLease.isCurrent()) return;
    void Share.share({ message: origin }).catch(() => {});
  };

  const closeCredentialModal = (): void => {
    if (credentialWorking) return;
    setCredentialModal(null);
    setCredentialText('');
    setCredentialIssue(null);
  };

  const onSubmitCredential = async (): Promise<void> => {
    if (credentialWorking || !accountLease.isCurrent()) return;
    const replacing = scopedCredentialSession;
    const candidate = credentialText.trim();
    if (!isScopedDeviceCredential(candidate)) {
      setCredentialIssue('That doesn’t look like a complete paired-client credential.');
      return;
    }

    // Keep an unconfirmed credential in the form so the owner can retry without losing the Mac's
    // one-time bearer. Once durable custody is confirmed, remove it from component state.
    setCredentialIssue(null);
    setCredentialSaved(false);
    setCredentialDiscardable(false);
    setCredentialWorking(true);
    try {
      const outcome = replacing
        ? await beginScopedCredentialReplacement(candidate)
        : await beginScopedCredentialUpgrade(candidate);
      if (!accountLease.isCurrent()) return;
      if (outcome.kind === 'adopted' || outcome.kind === 'adopted-cleanup-pending') {
        setCredentialText('');
        setCredentialModal(null);
        showDialog(
          replacing ? 'Credential replaced' : 'Device paired',
          replacing
            ? 'This phone now uses the new credential. The old credential was not revoked automatically; check the Mac dashboard before revoking it.'
            : outcome.kind === 'adopted'
              ? 'This phone now uses its own paired-client credential.'
              : 'This phone is paired. Secure cleanup will finish automatically after the next reconnect.',
        );
        return;
      }
      if (outcome.kind === 'retry') {
        if (replacing) {
          const status = await inspectScopedCredentialUpgradeStatus();
          if (!accountLease.isCurrent()) return;
          const confirmedSaved = status.kind === 'candidate' || status.kind === 'in-progress';
          setCredentialSaved(confirmedSaved);
          setCredentialDiscardable(status.kind === 'candidate');
          if (confirmedSaved) setCredentialText('');
          setCredentialIssue(
            status.kind === 'candidate' && outcome.stage === 'candidate-validation'
              ? 'The replacement is saved securely, but the server could not verify it. Gator will retry; if the value is wrong, revoke and remove it below before entering another. The old credential still works.'
              : confirmedSaved
                ? 'The replacement is saved securely. Gator will retry it when it reconnects; the old credential was not revoked automatically.'
                : 'Gator could not confirm that the replacement was saved. Your entry is still here so you can retry.',
          );
          return;
        }
        if (outcome.stage === 'candidate-validation' || outcome.stage === 'adoption') {
          setCredentialSaved(true);
          setCredentialDiscardable(outcome.stage === 'candidate-validation');
          setCredentialText('');
          setCredentialIssue(
            outcome.stage === 'candidate-validation'
              ? 'The credential was saved securely, but the server could not verify it. Gator will retry when it reconnects.'
              : 'The credential was saved securely, but the server could not finish pairing. Gator will retry when it reconnects.',
          );
          return;
        }
        const status = await inspectScopedCredentialUpgradeStatus();
        if (!accountLease.isCurrent()) return;
        const confirmedSaved = status.kind === 'candidate' || status.kind === 'in-progress';
        setCredentialSaved(confirmedSaved);
        setCredentialDiscardable(status.kind === 'candidate');
        if (confirmedSaved) setCredentialText('');
        setCredentialIssue(
          confirmedSaved
            ? 'The credential is saved securely, but this phone could not finish the secure update. Gator will retry when it reconnects.'
            : 'The secure update did not finish, and Gator could not confirm that the credential was saved. Return to the Mac dashboard and try again.',
        );
        return;
      }
      if (replacing && outcome.kind === 'blocked' && outcome.reason === 'push-target-owned') {
        const status = await inspectScopedCredentialUpgradeStatus();
        if (!accountLease.isCurrent()) return;
        const confirmedSaved = status.kind === 'candidate' || status.kind === 'in-progress';
        setCredentialSaved(confirmedSaved);
        setCredentialDiscardable(false);
        if (confirmedSaved) setCredentialText('');
        setCredentialIssue(
          'The Mac still has this phone’s push target assigned to another credential. In the Mac dashboard, remove only the old notification registration for this phone, not the old paired-client credential. Then Gator can retry; your phone data remains here.',
        );
        return;
      }
      if (outcome.kind === 'unsupported') {
        if (replacing) {
          const status = await inspectScopedCredentialUpgradeStatus();
          if (!accountLease.isCurrent()) return;
          const confirmedSaved = status.kind === 'candidate' || status.kind === 'in-progress';
          setCredentialSaved(confirmedSaved);
          setCredentialDiscardable(status.kind === 'candidate');
          if (confirmedSaved) setCredentialText('');
          setCredentialIssue(
            'The server cannot finish this replacement yet. Check the Mac dashboard; the old credential was not revoked automatically.',
          );
          return;
        }
        setCredentialSaved(true);
        setCredentialDiscardable(true);
        setCredentialText('');
        setCredentialIssue(
          outcome.reason === 'scoped-credentials'
            ? 'This server does not support paired-client credentials yet. Update the server, or revoke and remove the saved credential below.'
            : 'This server must support identity-protected push notifications before this credential can be used. Update the server, or revoke and remove it below.',
        );
        return;
      }
      if (outcome.kind === 'conflict') {
        // An older saved attempt refused this entry before anything was stored, so the entry stays
        // for a retry once that attempt finishes or is revoked. The status describes the older one.
        const status = await inspectScopedCredentialUpgradeStatus();
        if (!accountLease.isCurrent()) return;
        setCredentialSaved(status.kind === 'candidate' || status.kind === 'in-progress');
        setCredentialDiscardable(status.kind === 'candidate');
        setCredentialIssue(
          replacing
            ? 'A replacement is already saved for this phone. Gator will retry it automatically; the old credential was not revoked automatically.'
            : 'Another credential is already saved for this phone. Gator will finish it automatically, or you can try to revoke and remove it below.',
        );
        return;
      }
      if (outcome.kind === 'busy') {
        setCredentialIssue('Another secure connection change is in progress. Try again shortly.');
        return;
      }
      if (outcome.kind === 'revoked') {
        setCredentialIssue('This account is being disconnected. Reconnect it before pairing.');
        return;
      }
      if (outcome.kind === 'quarantined') {
        setCredentialIssue(
          replacing
            ? 'Replacement stopped because the saved secure state did not match this server session. The old credential was not revoked automatically; check the Mac dashboard.'
            : 'Pairing stopped because the saved secure state did not match this server session. Reconnect the server before trying again.',
        );
        return;
      }
      setCredentialIssue(
        replacing
          ? 'Replacement stopped because the account changed. Reopen this screen to try again.'
          : 'Pairing stopped because the account changed. Reopen this screen to try again.',
      );
    } catch {
      if (accountLease.isCurrent()) {
        setCredentialIssue(
          replacing
            ? 'Gator could not confirm that the replacement was saved. Your entry is still here so you can retry.'
            : 'Gator could not finish pairing. Check the Mac dashboard before trying again.',
        );
      }
    } finally {
      if (accountLease.isCurrent()) setCredentialWorking(false);
    }
  };

  const confirmDiscardCredential = (): void => {
    if (credentialWorking || !accountLease.isCurrent()) return;
    showConfirm({
      title: scopedCredentialSession
        ? 'Revoke the replacement credential?'
        : 'Revoke this credential?',
      message: scopedCredentialSession
        ? 'The server stops accepting it, and it is removed from this phone. This phone keeps using its current paired-client credential.'
        : 'The server stops accepting it, and it is removed from this phone. This phone keeps using the shared server password.',
      confirmText: 'Revoke and Remove',
      destructive: true,
      onConfirm: () => void onDiscardCredential(),
    });
  };

  const onDiscardCredential = async (): Promise<void> => {
    if (credentialWorking || !accountLease.isCurrent()) return;
    setCredentialWorking(true);
    try {
      const outcome = await discardScopedCredentialUpgradeCandidate();
      if (!accountLease.isCurrent()) return;
      if (outcome.kind === 'discarded' || outcome.kind === 'idle') {
        setCredentialSaved(false);
        setCredentialDiscardable(false);
        setCredentialIssue(null);
        setCredentialModal(null);
        showDialog(
          'Credential removed',
          scopedCredentialSession
            ? 'The replacement has no server authority and was removed from this phone. This phone still uses its previous paired-client credential.'
            : 'The credential is no longer authorized on the server and was removed from this phone. This phone still uses the shared server password.',
        );
        return;
      }
      if (outcome.kind === 'conflict') {
        setCredentialDiscardable(false);
        setCredentialIssue(
          'Pairing has already changed secure push state, so it can no longer be discarded. Gator will safely retry it.',
        );
        return;
      }
      if (outcome.kind === 'retry' && outcome.stage === 'candidate-revocation') {
        setCredentialSaved(true);
        setCredentialDiscardable(true);
        setCredentialIssue(
          'The server could not confirm that the credential was revoked, so Gator kept its secure copy. Try again when the server is reachable. If it keeps failing, revoke it in the Mac dashboard, then tap this button again.',
        );
        return;
      }
      if (outcome.kind === 'busy') {
        setCredentialIssue('Another secure connection change is in progress. Try again shortly.');
        return;
      }
      setCredentialIssue(
        'The saved credential could not be discarded safely. It remains protected.',
      );
    } finally {
      if (accountLease.isCurrent()) setCredentialWorking(false);
    }
  };

  // A retired screen must not adopt account B's store values before Expo Router unmounts it.
  const visibleServerInfo = accountCurrent ? serverInfo : null;
  const visibleOrigin = accountCurrent ? origin : null;
  const visibleSyncStatus = accountCurrent ? syncStatus : 'idle';
  const visibleSyncChats = accountCurrent ? syncChats : 0;
  const visibleSyncMessages = accountCurrent ? syncMessages : 0;
  const visibleRepairStatus = accountCurrent ? repairStatus : 'idle';
  const visibleRepairPhase = accountCurrent ? repairPhase : null;
  const visibleRepairLog = accountCurrent ? repairLog : [];
  const visibleRepairActive =
    visibleRepairStatus === 'queued' ||
    visibleRepairStatus === 'running' ||
    visibleRepairStatus === 'cancelling';

  return (
    <Screen>
      <ScreenHeader title="Server Management" onBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="STATUS">
          <InfoRow
            label="Connection"
            value={`${reachable == null ? 'Checking…' : reachable ? 'Reachable' : 'Unreachable'}${
              latency != null ? ` · ${latency} ms` : ''
            }`}
          />
          <InfoRow label="Server version" value={visibleServerInfo?.server_version ?? 'Unknown'} />
          <InfoRow label="macOS" value={visibleServerInfo?.os_version ?? 'Unknown'} />
          <InfoRow label="Private API" value="Retired in this release" />
          <InfoRow
            label="iMessage availability"
            value={iMessageAvailabilityCopy(visibleServerInfo?.supports_imessage_availability)}
          />
          <InfoRow label="Proxy" value={visibleServerInfo?.proxy_service ?? 'Direct'} />
          <Pressable
            onPress={onShareUrl}
            disabled={!visibleOrigin}
            accessibilityRole="button"
            accessibilityLabel={`Share server URL ${visibleOrigin ?? 'Unknown'}`}
            style={styles.row}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Server URL</Text>
            <Text
              style={[
                styles.rowValue,
                { color: visibleOrigin ? theme.color.tint : theme.color.secondaryLabel },
              ]}
              numberOfLines={1}
            >
              {visibleOrigin ?? 'Unknown'}
            </Text>
          </Pressable>
          <InfoRow
            label="Sync"
            value={
              visibleSyncStatus === 'syncing'
                ? `Syncing… (${visibleSyncChats} chats, ${visibleSyncMessages} msgs)`
                : visibleSyncStatus === 'done'
                  ? `Up to date (${visibleSyncMessages} msgs)`
                  : visibleSyncStatus === 'error'
                    ? 'Error'
                    : 'Idle'
            }
          />
        </SettingsSection>

        <SettingsSection label="ACTIONS" style={styles.gap}>
          <ActionRow label="Sync Now" disabled={syncStatus === 'syncing'} onPress={onSyncNow} />
          <ActionRow
            label="Server Health"
            onPress={() => {
              if (accountLease.isCurrent()) router.push('/server-health');
            }}
          />
          {pairingPayload ? (
            <ActionRow
              label={credentialSaved ? 'Finish Device Pairing' : 'Pair This Device'}
              disabled={credentialWorking}
              busy={credentialWorking}
              onPress={() => {
                if (accountLease.isCurrent()) {
                  setCredentialIssue(
                    credentialSaved
                      ? credentialDiscardable
                        ? 'A credential is saved securely. Gator will retry it automatically, or you can revoke and discard it below.'
                        : 'Pairing has already changed secure push state, so it cannot be discarded. Gator will retry it automatically.'
                      : null,
                  );
                  const animationType = modalAnimationFor(reduceMotion.current);
                  setCredentialModal((current) => current ?? animationType);
                }
              }}
            />
          ) : scopedCredentialSession ? (
            <>
              <InfoRow
                label="Device credential"
                value={credentialSaved ? 'Replacement pending' : 'Saved on phone'}
              />
              <ActionRow
                label={
                  credentialSaved ? 'Finish Credential Replacement' : 'Replace Device Credential'
                }
                disabled={credentialWorking}
                busy={credentialWorking}
                onPress={() => {
                  if (accountLease.isCurrent()) {
                    setCredentialIssue(
                      credentialSaved
                        ? credentialDiscardable
                          ? 'A replacement is saved securely. Gator will retry it automatically, or you can revoke and remove it below before entering another.'
                          : 'A replacement is saved securely. Gator will retry it automatically; the old credential was not revoked automatically.'
                        : null,
                    );
                    const animationType = modalAnimationFor(reduceMotion.current);
                    setCredentialModal((current) => current ?? animationType);
                  }
                }}
              />
            </>
          ) : null}
          {pairingPayload ? (
            <ActionRow
              label="Show Pairing QR"
              onPress={() => {
                if (accountLease.isCurrent()) {
                  const animationType = modalAnimationFor(reduceMotion.current);
                  setQrModal((current) => current ?? animationType);
                }
              }}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection label="LOCAL CACHE REPAIR" style={styles.gap}>
          <View style={styles.repairIntro}>
            <Text style={[styles.repairDescription, { color: theme.color.secondaryLabel }]}>
              Re-download server data without disconnecting or erasing your local choices.
            </Text>
          </View>
          {visibleRepairStatus !== 'idle' ? (
            <>
              <InfoRow
                label="Repair status"
                value={repairStatusCopy(visibleRepairStatus, visibleRepairPhase)}
              />
              <InfoRow
                label="Repair progress"
                value={`${visibleSyncChats.toLocaleString()} chats · ${visibleSyncMessages.toLocaleString()} messages`}
              />
              {visibleRepairLog.length > 0 ? (
                <View style={styles.repairLog}>
                  {visibleRepairLog.map((line, index) => (
                    <Text
                      key={`${index}-${line}`}
                      style={[styles.repairLogLine, { color: theme.color.secondaryLabel }]}
                    >
                      {line}
                    </Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
          <ActionRow
            label={
              visibleRepairActive
                ? visibleRepairStatus === 'cancelling'
                  ? 'Stopping Repair…'
                  : 'Cancel Repair'
                : visibleRepairStatus === 'cancelled' || visibleRepairStatus === 'error'
                  ? 'Restart Repair'
                  : 'Repair Local Cache'
            }
            disabled={visibleRepairStatus === 'cancelling' || !!busy}
            busy={visibleRepairStatus === 'cancelling'}
            onPress={visibleRepairActive ? onCancelRepair : onStartRepair}
          />
          <ActionRow
            label="Restore Deleted Conversations"
            disabled={!accountCurrent}
            onPress={() => {
              if (accountLease.isCurrent()) router.push('/deleted-chats');
            }}
          />
        </SettingsSection>

        <SettingsSection label="STATISTICS" style={styles.gap}>
          {scopedCredentialSession ? (
            <InfoRow label="Statistics" value="Mac dashboard only" />
          ) : (
            <>
              <InfoRow label="Messages" value={statVal(totals?.messages)} />
              <InfoRow label="Photos" value={statVal(totals?.images)} />
              <InfoRow label="Videos" value={statVal(totals?.videos)} />
              {statsError ? (
                <View style={styles.row}>
                  <Text style={[styles.errorText, { color: theme.color.destructive }]}>
                    {statsUnsupported
                      ? 'This server doesn’t expose statistics. It may be an older version, or a proxy may be blocking its statistics endpoint.'
                      : 'Couldn’t load statistics. Check your connection, then tap Refresh.'}
                  </Text>
                </View>
              ) : null}
              <ActionRow
                label="Refresh Statistics"
                disabled={!!busy}
                busy={busy === 'Load Stats'}
                onPress={onLoadStats}
              />
            </>
          )}
        </SettingsSection>
      </ScrollView>

      {/* Conditionally rendered (not just visible=false) so PairingQr fully unmounts on close,
          dropping any revealed QR state along with it. */}
      {accountCurrent && pairingPayload && qrModal ? (
        <Modal
          visible
          animationType={qrModal}
          onRequestClose={() => setQrModal(null)}
          testID="pairing-qr-modal"
        >
          <Screen>
            <ScreenHeader
              title="Pairing QR"
              right={
                <Pressable
                  onPress={() => setQrModal(null)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close pairing QR"
                >
                  <Text style={[styles.done, { color: theme.color.tint }]}>Done</Text>
                </Pressable>
              }
            />
            <PairingQr payload={pairingPayload} />
          </Screen>
        </Modal>
      ) : null}

      {/* Unmounting clears the secret TextInput and its native backing view. Keep an unconfirmed
          replacement only while this form stays open; clear it once secure custody is confirmed. */}
      {canManageCredential && credentialModal ? (
        <Modal
          visible
          animationType={credentialModal}
          onRequestClose={closeCredentialModal}
          testID="device-credential-modal"
        >
          <Screen>
            <ScreenHeader
              title={scopedCredentialSession ? 'Replace Device Credential' : 'Pair This Device'}
              right={
                <Pressable
                  onPress={closeCredentialModal}
                  disabled={credentialWorking}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close device pairing"
                >
                  <Text
                    style={[
                      styles.done,
                      { color: theme.color.tint, opacity: credentialWorking ? 0.4 : 1 },
                    ]}
                  >
                    Done
                  </Text>
                </Pressable>
              }
            />
            <ScrollView
              contentContainerStyle={styles.credentialContent}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[styles.credentialDescription, { color: theme.color.secondaryLabel }]}>
                {scopedCredentialSession
                  ? 'On your Mac, open Gator → Devices → Paired Client Credentials and create a new credential for this phone. Paste its one-time value here. This keeps your phone data; the old credential is not revoked automatically.'
                  : 'On your Mac, open the local Gator dashboard and create a device credential. The Mac shows it only once; paste it here so this phone can stop using the shared password.'}
              </Text>
              <SettingsSection>
                <TextInput
                  value={credentialText}
                  onChangeText={(value) => {
                    setCredentialText(value);
                    if (credentialIssue && !credentialSaved) setCredentialIssue(null);
                  }}
                  placeholder="Paired-client credential"
                  placeholderTextColor={theme.color.tertiaryLabel}
                  accessibilityLabel="Paired-client credential"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  maxLength={128}
                  editable={!credentialWorking && !credentialSaved}
                  style={[styles.credentialInput, { color: theme.color.label }]}
                />
              </SettingsSection>
              {credentialIssue ? (
                <Text style={[styles.credentialIssue, { color: theme.color.destructive }]}>
                  {credentialIssue}
                </Text>
              ) : null}
              {credentialSaved && credentialDiscardable ? (
                <ActionRow
                  label={
                    scopedCredentialSession
                      ? 'Revoke and Remove Replacement'
                      : 'Revoke and Remove Credential'
                  }
                  disabled={credentialWorking}
                  busy={credentialWorking}
                  destructive
                  onPress={confirmDiscardCredential}
                />
              ) : !credentialSaved ? (
                <ActionRow
                  label={scopedCredentialSession ? 'Use New Credential' : 'Use Credential'}
                  disabled={credentialWorking || !credentialText.trim()}
                  busy={credentialWorking}
                  onPress={() => void onSubmitCredential()}
                />
              ) : null}
            </ScrollView>
          </Screen>
        </Modal>
      ) : null}
    </Screen>
  );
}

/** Tinted/destructive action row (kit padding): busy shows '…' in place of the chevron. */
function ActionRow({
  label,
  onPress,
  disabled,
  busy,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const color = destructive ? theme.color.destructive : theme.color.tint;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.row, { opacity: disabled ? 0.4 : 1 }]}
    >
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
        {busy ? '…' : '›'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  gap: { marginTop: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  errorText: { fontSize: 14, flex: 1, lineHeight: 19 },
  repairIntro: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  repairDescription: { fontSize: 14, lineHeight: 20 },
  repairLog: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 4 },
  repairLogLine: { fontSize: 12, lineHeight: 17 },
  credentialContent: { padding: 16, gap: 16 },
  credentialDescription: { fontSize: 15, lineHeight: 21 },
  credentialInput: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  credentialIssue: { fontSize: 14, lineHeight: 20 },
  done: { fontSize: 17, textAlign: 'right' },
});
