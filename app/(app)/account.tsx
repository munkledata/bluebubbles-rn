import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as icloudApi from '@core/api/endpoints/icloud';
import type { AccountInfo } from '@core/api/endpoints/icloud';
import { ApiError, isUnimplementedEndpoint } from '@core/api/errors';
import { http } from '@/services';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import { showDialog } from '@ui/dialog/dialogStore';
import { CheckRow, InfoRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

/**
 * iMessage account (F-#8): the signed-in Apple account + a "Start Chats Using" alias picker.
 * Backed by the server's `/icloud/account` (+ `/icloud/account/alias`) endpoints, which read/set
 * the active send-from alias via the Private API helper. Requires the helper to be connected.
 */
export default function AccountScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  // The screen and every callback it creates belong to the account that mounted it. Including the
  // generation in the cache key prevents a late response from the old screen becoming initial data
  // (or an initial error) for the next account's screen.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const accountQueryKey = ['server', 'icloud-account', accountLease.generation] as const;

  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: async (): Promise<AccountInfo | null> => {
      if (!accountLease.isCurrent()) return null;
      try {
        const account = await icloudApi.getAccountInfo(http);
        // A GET owns no durable mutation, so it deliberately does not hold Disconnect open. Its
        // generation-specific key isolates TanStack Query's later cache commit, and this check
        // discards the old response itself.
        return accountLease.isCurrent() ? account : null;
      } catch (error) {
        // An old server's error is no more relevant to the new account than its data.
        if (!accountLease.isCurrent()) return null;
        throw error;
      }
    },
  });
  const info = accountQuery.data ?? null;
  // 'unsupported' = the server doesn't implement /icloud/account (a 404, remapped to
  // UnimplementedEndpointError) — a distinct, non-alarming state vs a real load 'error'.
  // 'loading' covers both the first fetch and the "Try again" refetch after an error.
  const status: 'loading' | 'ready' | 'error' | 'unsupported' =
    !accountLease.isCurrent() ||
    accountQuery.isPending ||
    (accountQuery.isError && accountQuery.isFetching)
      ? 'loading'
      : accountQuery.isError
        ? isUnimplementedEndpoint(accountQuery.error)
          ? 'unsupported'
          : 'error'
        : 'ready';
  // A 5xx means the request REACHED the server but it couldn't read the account — with this
  // endpoint that's almost always the Private API helper being off/restarting (helper-off
  // surfaces as a generic 500, not a 404 — see docs/IMESSAGE_ACCOUNT_PLAN.md). Say so instead
  // of blaming the connection.
  const helperDown =
    accountQuery.error instanceof ApiError && (accountQuery.error.status ?? 0) >= 500;

  // vettedAliases gates which aliases can be selected (Apple must have enabled them for iMessage);
  // when the server can't determine the list, allow any alias.
  const vetted = info?.vettedAliases ?? null;
  const canPick = (a: string): boolean => vetted == null || vetted.includes(a);

  const onPick = (alias: string): void => {
    if (
      !accountLease.isCurrent() ||
      !info ||
      alias === info.activeAlias ||
      saving ||
      !canPick(alias)
    )
      return;
    setSaving(alias);
    void (async () => {
      try {
        await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          await icloudApi.setActiveAlias(http, alias);
          if (!activeLease.isCurrent()) return;
          // setQueryData is synchronous, so the current-account check and cache commit cannot be
          // interleaved by Disconnect. The tracked slot also makes teardown wait for the POST.
          queryClient.setQueryData<AccountInfo | null>(accountQueryKey, (prev) =>
            prev ? { ...prev, activeAlias: alias } : prev,
          );
        });
      } catch {
        if (accountLease.isCurrent()) {
          showDialog(
            'Account',
            'Couldn’t change the active alias — make sure it’s enabled for iMessage on your Mac.',
          );
        }
      } finally {
        if (accountLease.isCurrent()) setSaving(null);
      }
    })();
  };

  return (
    <Screen>
      <ScreenHeader title="iMessage Account" onBack={() => router.back()} />

      {status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.tint} />
        </View>
      ) : status === 'unsupported' ? (
        <View style={styles.center}>
          <Text style={[styles.note, { color: theme.color.secondaryLabel, textAlign: 'center' }]}>
            This Gator server doesn’t provide iMessage account details yet. Nothing’s wrong with
            your setup — the feature just isn’t available on this server.
          </Text>
        </View>
      ) : status === 'error' ? (
        <View style={styles.center}>
          <Text style={[styles.note, { color: theme.color.secondaryLabel, textAlign: 'center' }]}>
            {helperDown
              ? 'The server responded, but couldn’t read your account — the Private API helper on your Mac may be off or restarting. Check the helper, then try again.'
              : 'Couldn’t load your account. Check your server connection and try again.'}
          </Text>
          <Pressable onPress={() => void accountQuery.refetch()} style={styles.retry}>
            <Text style={{ color: theme.color.tint, fontSize: 16 }}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <SettingsSection>
            <InfoRow label="Apple ID" value={info?.appleId ?? '—'} />
            <InfoRow label="Name" value={info?.displayName ?? '—'} />
            {info?.loginStatusMessage ? (
              <InfoRow label="Status" value={info.loginStatusMessage} />
            ) : null}
          </SettingsSection>

          <SettingsSection label="START CHATS USING" style={styles.gap}>
            {(info?.aliases ?? []).length === 0 ? (
              <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
                No aliases found.
              </Text>
            ) : (
              info!.aliases.map((a) => {
                const active = a === info!.activeAlias;
                return (
                  <CheckRow
                    key={a}
                    label={a}
                    checked={active}
                    onPress={() => onPick(a)}
                    disabled={active || !canPick(a) || saving != null}
                    dimmed={!canPick(a)}
                    loading={saving === a}
                  />
                );
              })
            )}
          </SettingsSection>
          <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
            New conversations are sent from the selected alias. Only aliases enabled for iMessage on
            your Mac can be used.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  content: { padding: 16 },
  gap: { marginTop: 24 },
  note: { fontSize: 13, marginTop: 12, marginHorizontal: 4, lineHeight: 18 },
  empty: { fontSize: 15, padding: 16 },
  retry: { paddingVertical: 8 },
});
