import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { serverApi } from '@core/api';
import { ApiError, isUnimplementedEndpoint } from '@core/api/errors';
import { http } from '@/services';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { captureSessionTransportLease, useSessionStore } from '@state/sessionStore';
import { showConfirm, showDialog } from '@ui/dialog/dialogStore';
import { InfoRow, NavRow, NoteRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

/** Account identity is sensitive, so a result belongs to both its account and exact server URL. */
export default function AccountScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const transportRevision = useSessionStore((s) => s.transportRevision);
  const accountLease = useScreenAccountLease();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [changingAlias, setChangingAlias] = useState(false);
  const aliasRequest = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const unsubscribe = subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
      aliasRequest.current?.abort();
      setAccountRetired(true);
    });
    return () => {
      unsubscribe();
      aliasRequest.current?.abort();
    };
  }, [accountLease]);

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const supported = accountCurrent && serverInfo?.supports_imessage_account_status === true;
  const aliasChangeSupported = supported && serverInfo?.supports_imessage_alias_change === true;
  const queryKey = [
    'imessage',
    'account-status',
    accountLease.generation,
    transportRevision,
  ] as const;
  const query = useQuery({
    queryKey,
    enabled: supported,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!accountLease.isCurrent()) return null;
      const transportLease = captureSessionTransportLease();
      if (transportLease.revision !== transportRevision || !transportLease.isCurrent()) return null;
      try {
        const status = await serverApi.imessageAccountStatus(http, signal);
        return accountLease.isCurrent() && transportLease.isCurrent() ? status : null;
      } catch (error) {
        if (!accountLease.isCurrent() || !transportLease.isCurrent()) return null;
        throw error;
      }
    },
  });
  const status = supported && accountCurrent ? query.data : null;
  const empty =
    status &&
    !status.appleId &&
    !status.displayName &&
    !status.activeAlias &&
    status.aliases.length === 0 &&
    status.vettedAliases.length === 0;

  const onSelectAlias = (alias: string): void => {
    if (
      !aliasChangeSupported ||
      changingAlias ||
      query.isFetching ||
      !status?.vettedAliases.includes(alias) ||
      status.activeAlias === alias
    )
      return;
    const transportLease = captureSessionTransportLease();
    if (transportLease.revision !== transportRevision || !transportLease.isCurrent()) return;
    showConfirm({
      title: 'Change send-from alias',
      message: `Use ${alias} as the Mac's active iMessage send-from alias?`,
      confirmText: 'Change',
      onConfirm: () => {
        if (
          !accountLease.isCurrent() ||
          !transportLease.isCurrent() ||
          useSessionStore.getState().serverInfo?.supports_imessage_alias_change !== true
        )
          return;
        const controller = new AbortController();
        aliasRequest.current = controller;
        setChangingAlias(true);
        void (async () => {
          try {
            const result = await serverApi.changeImessageActiveAlias(
              http,
              alias,
              controller.signal,
            );
            if (!accountLease.isCurrent() || !transportLease.isCurrent()) return;
            queryClient.setQueryData<serverApi.IMessageAccountStatus>(queryKey, (current) =>
              current ? { ...current, activeAlias: result.activeAlias } : current,
            );
            showDialog('Send-from alias', 'The change was confirmed on the Mac.');
            void queryClient.invalidateQueries({ queryKey });
          } catch (error) {
            if (
              controller.signal.aborted ||
              !accountLease.isCurrent() ||
              !transportLease.isCurrent()
            )
              return;
            if (
              error instanceof ApiError &&
              error.serverErrorType === 'imessage_alias_not_vetted'
            ) {
              showDialog(
                'Alias no longer enabled',
                'Refresh the account details before choosing another alias.',
              );
            } else {
              showDialog(
                'Change not confirmed',
                'Check the current alias on this screen or the Mac before trying again.',
              );
              void queryClient.invalidateQueries({ queryKey });
            }
          } finally {
            if (aliasRequest.current === controller) {
              aliasRequest.current = null;
              if (accountLease.isCurrent()) setChangingAlias(false);
            }
          }
        })();
      },
    });
  };

  return (
    <Screen grouped>
      <ScreenHeader title="iMessage Account" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {!accountCurrent ? (
          <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>
            Server account changed. Go back and reopen iMessage Account.
          </Text>
        ) : !supported ? (
          <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>
            Read-only iMessage account details are unavailable on this server.
          </Text>
        ) : query.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator accessibilityLabel="Loading iMessage account" />
          </View>
        ) : query.isError ? (
          <View style={styles.center}>
            <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>
              {isUnimplementedEndpoint(query.error)
                ? 'Read-only iMessage account details are unavailable on this server.'
                : 'Could not load iMessage account details.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry iMessage account"
              onPress={() => void query.refetch()}
            >
              <Text style={[styles.retry, { color: theme.color.tint }]}>Retry</Text>
            </Pressable>
          </View>
        ) : status === null || empty ? (
          <SettingsSection label="ACCOUNT">
            <NoteRow
              text={
                status?.loginStatusMessage ??
                'No signed-in iMessage account was reported by this Mac.'
              }
            />
          </SettingsSection>
        ) : status ? (
          <>
            <SettingsSection label="ACCOUNT">
              <InfoRow label="Apple ID" value={status.appleId ?? '—'} />
              <InfoRow label="Name" value={status.displayName ?? '—'} />
              <InfoRow label="Active alias" value={status.activeAlias ?? '—'} />
              {status.loginStatusMessage ? <NoteRow text={status.loginStatusMessage} /> : null}
            </SettingsSection>
            <SettingsSection label="ALIASES" style={styles.sectionGap}>
              <NoteRow
                text={`Enabled aliases: ${status.vettedAliases.length ? status.vettedAliases.join(', ') : 'None reported'}`}
              />
              <NoteRow
                text={`All aliases: ${status.aliases.length ? status.aliases.join(', ') : 'None reported'}`}
              />
              {!aliasChangeSupported ? (
                <NoteRow text="These details are read-only. Changing the send-from alias is not available." />
              ) : null}
            </SettingsSection>
            {aliasChangeSupported && status.vettedAliases.length > 0 ? (
              <SettingsSection label="CHANGE SEND-FROM ALIAS" style={styles.sectionGap}>
                {status.vettedAliases.map((alias) =>
                  alias === status.activeAlias ? (
                    <InfoRow key={alias} label={alias} value="Current" />
                  ) : (
                    <NavRow
                      key={alias}
                      label={alias}
                      accessibilityLabel={`Use ${alias} as send-from alias`}
                      disabled={changingAlias || query.isFetching}
                      onPress={() => onSelectAlias(alias)}
                    />
                  ),
                )}
              </SettingsSection>
            ) : null}
          </>
        ) : null}
        {supported && !query.isPending && !query.isError ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh iMessage account"
            disabled={query.isFetching}
            onPress={() => {
              if (accountCurrent) void query.refetch();
            }}
          >
            <Text style={[styles.retry, { color: theme.color.tint }]}>
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, flexGrow: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  retry: { fontSize: 16, marginTop: 16 },
  sectionGap: { marginTop: 20 },
});
