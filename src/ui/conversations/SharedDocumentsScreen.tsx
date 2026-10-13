import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatDocumentRow } from '@db/repositories';
import { useSharedDocuments } from '@features/conversations/useSharedDocuments';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { SharedDocumentRow } from '../attachments/FileChip';
import { Screen, ScreenHeader } from '../primitives';
import { useTheme } from '../theme';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

interface SharedDocumentsScreenProps {
  chatGuid: string | null;
}

interface SharedDocumentsAttemptProps {
  chatGuid: string | null;
  accountLease: RealtimeDeliveryLease;
  ownerIsCurrent: () => boolean;
}

const ACCOUNT_CHANGED_COPY = 'Conversation account changed. Go back and reopen Shared Documents.';

/** Account-owned wrapper: account retirement immediately removes every private document row. */
export function SharedDocumentsScreen({ chatGuid }: SharedDocumentsScreenProps): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const accountLease = useScreenAccountLease();
  const ownerMountedRef = useRef(true);
  const accountRetiredRef = useRef(!accountLease.isCurrent());
  const [accountRetired, setAccountRetired] = useState(accountRetiredRef.current);

  useLayoutEffect(() => {
    ownerMountedRef.current = true;
    const unsubscribe = subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
      accountRetiredRef.current = true;
      setAccountRetired(true);
    });
    return () => {
      ownerMountedRef.current = false;
      unsubscribe();
    };
  }, [accountLease]);

  const ownerIsCurrent = useCallback(
    (): boolean =>
      ownerMountedRef.current && !accountRetiredRef.current && accountLease.isCurrent(),
    [accountLease],
  );
  const accountCurrent = !accountRetired && ownerIsCurrent();

  return (
    <Screen>
      <ScreenHeader title="Shared Documents" onBack={() => router.back()} />
      {accountCurrent ? (
        <SharedDocumentsAttempt
          key={chatGuid ?? 'invalid'}
          chatGuid={chatGuid}
          accountLease={accountLease}
          ownerIsCurrent={ownerIsCurrent}
        />
      ) : (
        <View style={styles.center}>
          <Text
            accessibilityRole="alert"
            accessibilityLabel={ACCOUNT_CHANGED_COPY}
            style={[styles.message, { color: theme.color.secondaryLabel }]}
          >
            {ACCOUNT_CHANGED_COPY}
          </Text>
        </View>
      )}
    </Screen>
  );
}

function SharedDocumentsAttempt({
  chatGuid,
  accountLease,
  ownerIsCurrent,
}: SharedDocumentsAttemptProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const screenIsCurrent = useCallback(
    (): boolean => mountedRef.current && ownerIsCurrent(),
    [ownerIsCurrent],
  );
  const { data, error, isLoading, hasMore, loadingMore, loadMoreError, loadMore, retry } =
    useSharedDocuments(chatGuid, accountLease, screenIsCurrent());
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatDocumentRow>): React.JSX.Element => (
      <SharedDocumentRow
        attachment={item}
        accountLease={accountLease}
        screenIsCurrent={screenIsCurrent}
      />
    ),
    [accountLease, screenIsCurrent],
  );

  if (chatGuid == null) {
    return <CenteredMessage text="This Shared Documents link is invalid." />;
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={[styles.message, { color: theme.color.destructive }]}
        >
          Couldn’t load shared documents.
        </Text>
        <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
          <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
        </Pressable>
      </View>
    );
  }
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.color.tint} />
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.message, { color: theme.color.label }]}
        >
          Loading shared documents…
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="shared-documents-list"
      data={data?.items ?? []}
      keyExtractor={(item) => item.guid}
      renderItem={renderItem}
      ItemSeparatorComponent={DocumentSeparator}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(insets.bottom, 20) }]}
      onEndReached={hasMore ? loadMore : undefined}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={<CenteredMessage text="No shared documents in this conversation." />}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator color={theme.color.tint} />
            <Text style={[styles.footerText, { color: theme.color.secondaryLabel }]}>
              Loading more…
            </Text>
          </View>
        ) : loadMoreError ? (
          <View style={styles.footer}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[styles.footerText, { color: theme.color.destructive }]}
            >
              Couldn’t load more documents. The documents above are still available.
            </Text>
            <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          </View>
        ) : null
      }
    />
  );
}

function DocumentSeparator(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />;
}

function CenteredMessage({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { flexGrow: 1 },
  center: { flex: 1, paddingTop: 80, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  message: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  retryText: { fontSize: 16, fontWeight: '600' },
  footer: { paddingVertical: 18, paddingHorizontal: 24, alignItems: 'center', gap: 6 },
  footerText: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
});
