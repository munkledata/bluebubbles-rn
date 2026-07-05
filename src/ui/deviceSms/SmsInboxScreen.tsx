import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatSmsAddress, smsSnippetLabel } from '@core/sms';
import { formatChatDate } from '@utils';
import {
  hasSmsPermissions,
  isDeviceSmsAvailable,
  listSmsThreads,
  requestSmsPermissions,
  resolveSmsGroupTitle,
  resolveSmsSenderName,
  subscribeIncomingSms,
  subscribeProviderChanged,
  syncSmsNotificationPrefs,
  type SmsThreadInfo,
} from '@/services/deviceSms/deviceSmsService';
import { Avatar, Button, Icon, Screen, usePullToRefresh, useTheme } from '@ui';

type Gate = 'checking' | 'unavailable' | 'needs-permission' | 'granted';

/**
 * Phone SMS inbox — device SIM threads, SEPARATE from the iMessage/relay inbox.
 * Gated behind availability (native module linked?) + runtime SMS permissions.
 */
export function SmsInboxScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [gate, setGate] = useState<Gate>('checking');
  const [threads, setThreads] = useState<SmsThreadInfo[]>([]);
  // threadId -> resolved display title (group title for group threads, sender name for 1:1).
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await listSmsThreads(200, 0);
      setThreads(rows);
      // Resolve display titles best-effort, in parallel; merge so a title never flickers back.
      const entries = await Promise.all(
        rows.map(async (t) => {
          const title = t.isGroup
            ? await resolveSmsGroupTitle(t.recipients)
            : await resolveSmsSenderName(t.address);
          return [t.threadId, title] as const;
        }),
      );
      setTitles((prev) => {
        const next = { ...prev };
        for (const [id, title] of entries) next[id] = title;
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const initGate = useCallback(async (): Promise<void> => {
    if (!isDeviceSmsAvailable()) {
      setGate('unavailable');
      return;
    }
    if (await hasSmsPermissions()) {
      setGate('granted');
      // Enable the killed-app notification path (cheap + idempotent) now that we know
      // permissions are held and sync the current hide-preview flag.
      void syncSmsNotificationPrefs();
      await load();
    } else {
      setGate('needs-permission');
    }
  }, [load]);

  useEffect(() => {
    void initGate();
  }, [initGate]);

  const onAllow = useCallback(async (): Promise<void> => {
    const granted = await requestSmsPermissions();
    if (granted) {
      setGate('granted');
      // Enable the killed-app notification path immediately after the grant.
      void syncSmsNotificationPrefs();
      await load();
    }
  }, [load]);

  // Refetch when the screen regains focus (e.g. returning from a thread).
  useFocusEffect(
    useCallback(() => {
      if (gate === 'granted') void load();
    }, [gate, load]),
  );

  // Refetch on incoming SMS (no-op unsubscribe when the module is unavailable).
  useEffect(() => {
    if (gate !== 'granted') return;
    return subscribeIncomingSms(() => void load());
  }, [gate, load]);

  // Refetch on ANY provider change — this also surfaces incoming MMS once the default SMS
  // app finishes downloading them (the incoming-SMS event doesn't fire for MMS). Debounced
  // native-side, so a direct reload here is fine.
  useEffect(() => {
    if (gate !== 'granted') return;
    return subscribeProviderChanged(() => void load());
  }, [gate, load]);

  // Read titles through a ref so the row press handler stays stable (memoized rows).
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  const openThread = useCallback(
    (t: SmsThreadInfo): void => {
      router.push({
        pathname: '/device-sms/[threadId]',
        params: {
          threadId: String(t.threadId),
          address: t.address,
          name: titlesRef.current[t.threadId] ?? '',
          isGroup: t.isGroup ? '1' : '0',
        },
      });
    },
    [router],
  );

  const { refreshControl } = usePullToRefresh(load);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
        <Icon name="chevron-back" size={28} color={theme.color.tint} />
      </Pressable>
      <Text style={[styles.title, { color: theme.color.label }]}>Phone SMS</Text>
      {gate === 'granted' ? (
        <Pressable
          onPress={() => router.push('/device-sms/new')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New text message"
        >
          <Icon name="create-outline" size={24} color={theme.color.tint} />
        </Pressable>
      ) : (
        <View style={styles.headerSpacer} />
      )}
    </View>
  );

  let body: React.JSX.Element;
  if (gate === 'checking') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.color.tint} />
      </View>
    );
  } else if (gate === 'unavailable') {
    body = (
      <View style={styles.explainer}>
        <Icon name="chatbubble-ellipses-outline" size={48} color={theme.color.tertiaryLabel} />
        <Text style={[styles.explainTitle, { color: theme.color.label }]}>Phone SMS unavailable</Text>
        <Text style={[styles.explainBody, { color: theme.color.secondaryLabel }]}>
          Sending and reading text messages from this phone’s SIM requires a rebuild of the app.
        </Text>
      </View>
    );
  } else if (gate === 'needs-permission') {
    body = (
      <View style={styles.explainer}>
        <Icon name="chatbubbles-outline" size={48} color={theme.color.tint} />
        <Text style={[styles.explainTitle, { color: theme.color.label }]}>Text from this phone</Text>
        <Text style={[styles.explainBody, { color: theme.color.secondaryLabel }]}>
          Send and receive text messages using this phone’s own number — separate from iMessage and
          the SMS relayed through your Mac.
        </Text>
        <Button title="Allow SMS access" onPress={() => void onAllow()} style={styles.allowBtn} />
      </View>
    );
  } else {
    body = (
      <FlashList
        data={threads}
        keyExtractor={(t: SmsThreadInfo) => String(t.threadId)}
        refreshControl={refreshControl}
        renderItem={({ item }: { item: SmsThreadInfo }) => (
          <ThreadRow thread={item} name={titles[item.threadId]} onPress={openThread} />
        )}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.color.tint} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={[styles.emptyText, { color: theme.color.secondaryLabel }]}>
                No text conversations
              </Text>
            </View>
          )
        }
        contentContainerStyle={styles.listContent}
      />
    );
  }

  return (
    <Screen>
      {header}
      <View style={styles.flex}>{body}</View>
    </Screen>
  );
}

const ThreadRow = React.memo(function ThreadRow({
  thread,
  name,
  onPress,
}: {
  thread: SmsThreadInfo;
  name: string | undefined;
  onPress: (t: SmsThreadInfo) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const title = name || formatSmsAddress(thread.address);
  const unread = thread.unreadCount > 0;
  return (
    <Pressable
      onPress={() => onPress(thread)}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`Conversation with ${title}`}
    >
      <View style={styles.unreadCol}>
        {unread ? <View style={[styles.unreadDot, { backgroundColor: theme.color.tint }]} /> : null}
      </View>
      <Avatar name={title} size={48} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text
            numberOfLines={1}
            style={[styles.rowTitle, { color: theme.color.label, fontWeight: unread ? '700' : '600' }]}
          >
            {title}
          </Text>
          <Text style={[styles.rowDate, { color: theme.color.tertiaryLabel }]}>
            {formatChatDate(thread.date)}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          style={[
            styles.rowSnippet,
            { color: unread ? theme.color.label : theme.color.secondaryLabel },
          ]}
        >
          {smsSnippetLabel(thread.snippet)}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  title: { fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 24 },
  center: { paddingTop: 80, alignItems: 'center' },
  emptyText: { fontSize: 16 },
  explainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14 },
  explainTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  explainBody: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  allowBtn: { marginTop: 8, alignSelf: 'stretch' },
  listContent: { paddingBottom: 24 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  unreadCol: { width: 10, alignItems: 'center' },
  unreadDot: { width: 8, height: 8, borderRadius: 4 },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 16, flex: 1, marginRight: 8 },
  rowDate: { fontSize: 13 },
  rowSnippet: { fontSize: 14, marginTop: 2 },
});
