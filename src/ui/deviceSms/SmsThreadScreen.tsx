import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { attachmentChipLabel, classifyAttachmentKind, formatSmsAddress } from '@core/sms';
import { formatTime } from '@utils';
import {
  getSmsThreadAddress,
  listSmsMessages,
  resolveSmsSenderName,
  sendDeviceSms,
  subscribeIncomingSms,
  subscribeProviderChanged,
  type SmsAttachmentInfo,
  type SmsMessageInfo,
  type SmsMessageStatus,
} from '@/services/deviceSms/deviceSmsService';
import { Composer, Icon, Screen, useTheme, type IconName } from '@ui';

const PAGE = 100;

/** A row to render: either a persisted provider message or an optimistic temp. */
interface DisplayMessage {
  key: string;
  /** Sender/recipient address (drives group sender-label resolution). */
  address: string;
  body: string;
  date: number;
  isFromMe: boolean;
  status: SmsMessageStatus;
  /** MMS parts (empty for SMS / text-only MMS). */
  attachments: SmsAttachmentInfo[];
}

/** A DisplayMessage decorated with per-row group presentation flags. */
interface RenderRow extends DisplayMessage {
  showSender: boolean;
  senderLabel: string;
}

function toDisplay(m: SmsMessageInfo): DisplayMessage {
  return {
    key: `db-${m.id}`,
    address: m.address,
    body: m.body,
    date: m.date,
    isFromMe: m.isFromMe,
    status: m.status,
    attachments: m.attachments,
  };
}

/** Ionicons glyph for a non-image attachment chip. */
function iconForKind(contentType: string): IconName {
  switch (classifyAttachmentKind(contentType)) {
    case 'video':
      return 'videocam-outline';
    case 'audio':
      return 'musical-notes-outline';
    default:
      return 'document-outline';
  }
}

/** A single device-SMS conversation: chronological bubbles + composer. */
export function SmsThreadScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    threadId: string;
    address?: string;
    name?: string;
    isGroup?: string;
  }>();
  const threadId = Number(params.threadId);
  // Group flag comes from the inbox. The killed-app SMS deep link (only path that omits it)
  // always targets a 1:1 thread — a group is MMS — so absence safely means non-group.
  const isGroup = params.isGroup === '1';
  const { width: windowWidth } = useWindowDimensions();

  // The address is handed over by the inbox, but a killed-app notification deep link opens
  // this screen with ONLY the thread id — derive the address from the thread in that case.
  const [address, setAddress] = useState<string>(params.address ?? '');
  const [serverMsgs, setServerMsgs] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState<DisplayMessage[]>([]);
  const [title, setTitle] = useState<string>(params.name || formatSmsAddress(params.address ?? ''));
  const [hasMore, setHasMore] = useState(true);
  // address -> resolved sender name, for the per-bubble group labels (received only).
  const [senderNames, setSenderNames] = useState<Record<string, string>>({});

  // Deep-link path: no address param -> resolve it (and seed a readable title) from the thread.
  useEffect(() => {
    if (address || !Number.isFinite(threadId)) return;
    let active = true;
    void getSmsThreadAddress(threadId).then((a) => {
      if (!active || !a) return;
      setAddress(a);
      setTitle((t) => t || formatSmsAddress(a));
    });
    return () => {
      active = false;
    };
  }, [address, threadId]);

  // Resolve a nicer title if the inbox didn't hand one over.
  useEffect(() => {
    if (params.name || !address) return;
    let active = true;
    void resolveSmsSenderName(address).then((n) => {
      if (active && n) setTitle(n);
    });
    return () => {
      active = false;
    };
  }, [params.name, address]);

  const load = useCallback(async (): Promise<void> => {
    if (!Number.isFinite(threadId)) return;
    const rows = await listSmsMessages(threadId, PAGE, 0);
    setServerMsgs(rows.map(toDisplay));
  }, [threadId]);

  // A single follow-up refetch timer: the system SMS app writes the sent/received
  // provider row on its own schedule and can lag our refetch — a second load ~1.2s
  // later picks up a row the first pass missed (so a just-sent bubble never vanishes).
  const followupRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadWithFollowup = useCallback(async (): Promise<void> => {
    await load();
    if (followupRef.current) clearTimeout(followupRef.current);
    followupRef.current = setTimeout(() => void load(), 1200);
  }, [load]);
  useEffect(
    () => () => {
      if (followupRef.current) clearTimeout(followupRef.current);
    },
    [],
  );

  const loadEarlier = useCallback(async (): Promise<void> => {
    const oldest = serverMsgs[0];
    if (!oldest || !Number.isFinite(threadId)) return;
    const older = await listSmsMessages(threadId, PAGE, oldest.date);
    if (older.length === 0) {
      setHasMore(false);
      return;
    }
    setServerMsgs((cur) => {
      const seen = new Set(cur.map((m) => m.key));
      const add = older.map(toDisplay).filter((m) => !seen.has(m.key));
      if (add.length === 0) setHasMore(false);
      return [...add, ...cur];
    });
  }, [serverMsgs, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Refetch on incoming SMS for THIS thread, after a short delay — the system's
  // default SMS app writes the provider row and can race the broadcast.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeIncomingSms((e) => {
      if (e.threadId !== threadId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [threadId, load]);

  // Refetch on ANY provider change (the debounced native observer). This is what finally
  // surfaces an incoming MMS live — the default SMS app downloads it asynchronously, so no
  // incoming broadcast carries the body. Guarded with its own debounce against refetch storms.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeProviderChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [load]);

  // Resolve sender names for a GROUP thread's received addresses (for the per-bubble labels).
  useEffect(() => {
    if (!isGroup) return;
    const addrs = Array.from(
      new Set(serverMsgs.filter((m) => !m.isFromMe && m.address).map((m) => m.address)),
    );
    const missing = addrs.filter((a) => senderNames[a] === undefined);
    if (missing.length === 0) return;
    let active = true;
    void Promise.all(missing.map(async (a) => [a, await resolveSmsSenderName(a)] as const)).then(
      (entries) => {
        if (!active) return;
        setSenderNames((prev) => {
          const next = { ...prev };
          for (const [a, n] of entries) next[a] = n;
          return next;
        });
      },
    );
    return () => {
      active = false;
    };
  }, [isGroup, serverMsgs, senderNames]);

  const onSend = useCallback(
    (text: string): void => {
      const body = text.trim();
      if (!body || !address) return;
      const key = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const temp: DisplayMessage = {
        key,
        address,
        body,
        date: Date.now(),
        isFromMe: true,
        status: 'sending',
        attachments: [],
      };
      setPending((p) => [...p, temp]);
      void (async () => {
        try {
          await sendDeviceSms(address, body);
          // The provider now holds the sent row — drop the temp and refetch it in
          // (with a follow-up load to cover the system's provider-write lag).
          setPending((p) => p.filter((m) => m.key !== key));
          await loadWithFollowup();
        } catch {
          setPending((p) => p.map((m) => (m.key === key ? { ...m, status: 'failed' } : m)));
        }
      })();
    },
    [address, loadWithFollowup],
  );

  const retry = useCallback(
    (msg: DisplayMessage): void => {
      if (!address) return;
      setPending((p) => p.map((m) => (m.key === msg.key ? { ...m, status: 'sending' } : m)));
      void (async () => {
        try {
          await sendDeviceSms(address, msg.body);
          setPending((p) => p.filter((m) => m.key !== msg.key));
          await loadWithFollowup();
        } catch {
          setPending((p) => p.map((m) => (m.key === msg.key ? { ...m, status: 'failed' } : m)));
        }
      })();
    },
    [address, loadWithFollowup],
  );

  const data = useMemo<RenderRow[]>(() => {
    const all = [...serverMsgs, ...pending];
    return all.map((m, i) => {
      const prev = i > 0 ? all[i - 1] : undefined;
      // In a group, label a received bubble only when it STARTS a run from a new sender
      // (mirrors the iMessage sender-header convention, kept lightweight).
      const showSender =
        isGroup && !m.isFromMe && (!prev || prev.isFromMe || prev.address !== m.address);
      const senderLabel = showSender
        ? (senderNames[m.address] ?? formatSmsAddress(m.address))
        : '';
      return { ...m, showSender, senderLabel };
    });
  }, [serverMsgs, pending, isGroup, senderNames]);

  // Inline MMS image width: ~60% of the screen, capped, so it sits comfortably in a bubble.
  const imageWidth = useMemo(() => Math.min(240, Math.round(windowWidth * 0.6)), [windowWidth]);

  // Only pad WHILE the keyboard is up (Android edge-to-edge) — same fix as the chat screen,
  // else a residual nav-bar-sized gap is left under the composer after a show/hide cycle.
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKbVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="chevron-back" size={28} color={theme.color.tint} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
          {title || 'Messages'}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        <FlashList
          data={data}
          keyExtractor={(m: RenderRow) => m.key}
          renderItem={({ item }: { item: RenderRow }) => (
            <SmsBubble msg={item} imageWidth={imageWidth} onRetry={retry} />
          )}
          maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
          ListHeaderComponent={
            hasMore && serverMsgs.length >= PAGE ? (
              <Pressable
                onPress={() => void loadEarlier()}
                style={styles.loadEarlier}
                accessibilityRole="button"
              >
                <Text style={[styles.loadEarlierText, { color: theme.color.tint }]}>
                  Load earlier messages
                </Text>
              </Pressable>
            ) : null
          }
          contentContainerStyle={styles.listContent}
        />
        <Composer onSend={onSend} placeholder="Text Message" />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const SmsBubble = React.memo(function SmsBubble({
  msg,
  imageWidth,
  onRetry,
}: {
  msg: RenderRow;
  imageWidth: number;
  onRetry: (m: DisplayMessage) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const b = theme.color.bubble;
  const isFromMe = msg.isFromMe;
  const failed = msg.status === 'failed';
  const sending = msg.status === 'sending';
  const backgroundColor = isFromMe ? b.smsBackground : b.receivedBackgroundBottom;
  const textColor = isFromMe ? b.senderText : b.receivedText;

  const hasText = msg.body.trim().length > 0;
  const images = msg.attachments.filter((a) => classifyAttachmentKind(a.contentType) === 'image');
  const others = msg.attachments.filter((a) => classifyAttachmentKind(a.contentType) !== 'image');
  // An attachment-only image needs no bubble chrome — the image supplies its own rounding.
  const bare = !hasText && others.length === 0 && images.length > 0;

  return (
    <View style={[styles.bubbleRow, { alignItems: isFromMe ? 'flex-end' : 'flex-start' }]}>
      {msg.showSender ? (
        <Text numberOfLines={1} style={[styles.sender, { color: theme.color.secondaryLabel }]}>
          {msg.senderLabel}
        </Text>
      ) : null}
      <Pressable
        disabled={!failed}
        onPress={() => onRetry(msg)}
        style={[
          bare ? styles.bubbleBare : [styles.bubble, { backgroundColor }],
          { opacity: sending ? 0.6 : 1 },
        ]}
      >
        {images.map((a, i) => (
          <Image
            key={a.partId}
            source={{ uri: a.uri }}
            style={[
              styles.image,
              { width: imageWidth },
              i > 0 || (!bare && hasText) ? styles.imageStacked : null,
            ]}
            contentFit="cover"
            transition={120}
          />
        ))}
        {others.map((a) => (
          <View key={a.partId} style={styles.chip}>
            <Icon name={iconForKind(a.contentType)} size={18} color={textColor} />
            <Text numberOfLines={1} style={[styles.chipText, { color: textColor }]}>
              {attachmentChipLabel(a)}
            </Text>
          </View>
        ))}
        {hasText ? (
          <Text
            style={[
              styles.bubbleText,
              { color: textColor },
              msg.attachments.length > 0 ? styles.textAfterAttachment : null,
            ]}
          >
            {msg.body}
          </Text>
        ) : null}
      </Pressable>
      {failed ? (
        <Text style={[styles.status, { color: theme.color.destructive }]}>Not delivered · Tap to retry</Text>
      ) : (
        <Text style={[styles.status, { color: theme.color.tertiaryLabel }]}>{formatTime(msg.date)}</Text>
      )}
    </View>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600', flex: 1, textAlign: 'center', marginHorizontal: 8 },
  headerSpacer: { width: 28 },
  listContent: { paddingHorizontal: 12, paddingVertical: 8 },
  loadEarlier: { alignItems: 'center', paddingVertical: 12 },
  loadEarlierText: { fontSize: 14, fontWeight: '500' },
  bubbleRow: { marginVertical: 3 },
  bubble: { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  // Attachment-only image: no background/padding, cap width to the bubble max.
  bubbleBare: { maxWidth: '78%' },
  bubbleText: { fontSize: 16 },
  // Text under an attachment gets a little separation from the media above it.
  textAfterAttachment: { marginTop: 6 },
  sender: { fontSize: 12, marginBottom: 2, marginHorizontal: 8 },
  image: { height: 240, borderRadius: 14, maxWidth: '100%' },
  imageStacked: { marginTop: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  chipText: { fontSize: 15, fontWeight: '500' },
  status: { fontSize: 11, marginTop: 2, marginHorizontal: 4 },
});
