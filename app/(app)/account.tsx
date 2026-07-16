import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as icloudApi from '@core/api/endpoints/icloud';
import type { AccountInfo } from '@core/api/endpoints/icloud';
import { http } from '@/services';
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

  const accountQuery = useQuery({
    queryKey: ['server', 'icloud-account'],
    queryFn: () => icloudApi.getAccountInfo(http),
  });
  const info = accountQuery.data ?? null;
  // 'loading' covers both the first fetch and the "Try again" refetch after an error.
  const status: 'loading' | 'ready' | 'error' =
    accountQuery.isPending || (accountQuery.isError && accountQuery.isFetching)
      ? 'loading'
      : accountQuery.isError
        ? 'error'
        : 'ready';

  // vettedAliases gates which aliases can be selected (Apple must have enabled them for iMessage);
  // when the server can't determine the list, allow any alias.
  const vetted = info?.vettedAliases ?? null;
  const canPick = (a: string): boolean => vetted == null || vetted.includes(a);

  const onPick = (alias: string): void => {
    if (!info || alias === info.activeAlias || saving || !canPick(alias)) return;
    setSaving(alias);
    void (async () => {
      try {
        await icloudApi.setActiveAlias(http, alias);
        queryClient.setQueryData<AccountInfo>(['server', 'icloud-account'], (prev) =>
          prev ? { ...prev, activeAlias: alias } : prev,
        );
      } catch {
        showDialog(
          'Account',
          'Couldn’t change the active alias — make sure it’s enabled for iMessage on your Mac.',
        );
      } finally {
        setSaving(null);
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
      ) : status === 'error' ? (
        <View style={styles.center}>
          <Text style={[styles.note, { color: theme.color.secondaryLabel, textAlign: 'center' }]}>
            Couldn’t load your account. This needs the Private API helper connected on your server.
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
