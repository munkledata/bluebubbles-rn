import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getChatIdByGuid,
  getChatParticipants,
  getFirstUnreadInChat,
  kvGet,
  kvSet,
  type MessagePreview,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import {
  dispatchRealtimeEvent,
  ensureChatSynced,
  ensureSyncedBackground,
  http,
  markRead,
  sendTyping,
} from '@/services';
import { getDatabase } from '@db/database';
import { clearChatNotification } from '@/services/notifications/notifeeService';
import {
  editText,
  fireDueScheduled,
  reply,
  runDueScheduled,
  schedule,
  send,
  sendImage,
  sendImages,
} from '@/services/send';
import {
  devEditFake,
  devInjectEffect,
  devSendFake,
  devSendFakeReply,
} from '@features/conversations/devSeed';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useMessageActions } from '@features/conversations/useMessageActions';
import { useMessages } from '@features/conversations/useMessages';
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
import { isDevServer } from '@utils/isDev';
import {
  Composer,
  ConversationHeader,
  EdgeFade,
  EditHistorySheet,
  MessageActionsOverlay,
  MessageList,
  Screen,
  ThreadSheet,
  ScreenEffectOverlay,
  SmartReplyChips,
  TypingBubble,
  useTheme,
  type PendingAttachment,
} from '@ui';
import { ChatThemeProvider, useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';
import { useTypingStore } from '@state/typingStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { isGroupRow, resolveChatService, resolveTitle } from '@utils';

// Lazy: expo-audio (native) is only pulled in when the user actually records a voice memo,
// so the chat opens fine on a build that hasn't linked the module yet.
const VoiceRecorder = lazy(() =>
  import('@ui/conversations/VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })),
);

/**
 * Phase 4 conversation view: reactive message list + composer with optimistic send.
 * Wrapped in ChatThemeProvider so a per-chat theme (Phase 3.2) recolors the whole
 * conversation — every `useTheme()` below (including Screen) sees the chat override.
 */
export default function ChatScreen(): React.JSX.Element {
  // `focus`/`focusDate` arrive when opened from a search hit — scroll to + highlight that message.
  const { guid, focus, focusDate } = useLocalSearchParams<{
    guid: string;
    focus?: string;
    focusDate?: string;
  }>();
  return (
    <ChatThemeProvider guid={guid}>
      <ChatScreenInner guid={guid} focusGuid={focus} focusDate={focusDate} />
    </ChatThemeProvider>
  );
}

function ChatScreenInner({
  guid,
  focusGuid,
  focusDate,
}: {
  guid: string;
  focusGuid?: string;
  focusDate?: string;
}): React.JSX.Element {
  const header = useChatHeader(guid);
  const backgroundUri = useChatBackgroundUri(guid);
  const isGroup = header.data ? isGroupRow(header.data) : false;
  // The chat's service for the badge, composer placeholder, and outgoing-bubble colour. Resolved
  // from the participant handle service (not just the guid prefix) so an SMS-only thread reads SMS.
  const chatService = resolveChatService(guid, header.data?.handleServices);
  // When focusing a search hit, load a window CENTERED on it (context on both sides) instead of the
  // recent window; otherwise the normal recent window. ONE message subscription for the whole screen
  // — fed to the list, smart-reply chips, and the screen-effect trigger (avoids 3× the query work).
  const anchorNum = focusDate ? Number(focusDate) : NaN;
  const routeAnchorDate = Number.isFinite(anchorNum) ? anchorNum : undefined;
  // "Jump to oldest unread" reuses the search-hit anchor plumbing: tapping the chip anchors the
  // window on the first unread message (declared here, above useMessages, for hook order).
  const [jump, setJump] = useState<{ guid: string; dateCreated: number } | null>(null);
  const anchorDate = routeAnchorDate ?? jump?.dateCreated;
  const effFocusGuid = focusGuid ?? jump?.guid;
  // The message window grows as the user scrolls back through history (see onLoadOlder). Starts at
  // one screen-worth+ and pages by PAGE_SIZE. In search-anchor mode the window is centered on the
  // hit instead (limit is ignored), so pagination is disabled there.
  const [limit, setLimit] = useState(250);
  const { data: messagesData, error: messagesError } = useMessages(guid, limit, anchorDate);
  const messages = messagesData ?? [];
  // Load older history when the list reaches the top. Guarded so repeated onStartReached fires (and
  // the async reactive re-query) can't stack several page-grows at once: the ref is set on grow and
  // cleared when the message count actually changes (new page arrived). Growth stops once a load
  // returns fewer rows than requested — that means the start of history is reached.
  const loadingOlderRef = useRef(false);
  useEffect(() => {
    loadingOlderRef.current = false;
  }, [messages.length]);
  const onLoadOlder = useCallback((): void => {
    if (anchorDate != null || loadingOlderRef.current) return;
    if (messages.length < limit) return;
    loadingOlderRef.current = true;
    setLimit((n) => n + 200);
  }, [anchorDate, messages.length, limit]);
  const isTyping = useTypingStore((s) => !!s.typing[guid]);
  const sendSubjectLines = useFeatureSettingsStore((s) => s.sendSubjectLines);
  // Group participants for @mention autocomplete (reactive so contact-sync name updates flow in).
  const { data: participants } = useReactiveQuery<{ address: string; name: string }[]>(
    async () => (isGroup ? getChatParticipants(getDatabase(), guid) : []),
    ['chat_handles', 'handles'],
    [guid, isGroup],
  );
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{ guid: string; text: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const screenEffect = useNewScreenEffect(guid, messages);
  // "Jump to oldest unread": captured BEFORE markRead moves the read marker. The chip shows only
  // when the backlog is deep enough that the oldest unread sits off-screen above the opening view.
  const [firstUnread, setFirstUnread] = useState<{
    guid: string;
    dateCreated: number;
    count: number;
  } | null>(null);

  // Runs once per guid (the deps are exactly [guid]) — no once-ref, so a reused screen
  // instance that receives a NEW guid marks the new chat read/synced too.
  useEffect(() => {
    if (!guid) return;
    void (async () => {
      // Capture the oldest-unread target BEFORE markRead clears the marker.
      try {
        const db = getDatabase();
        const chatId = await getChatIdByGuid(db, guid);
        if (chatId != null) {
          const fu = await getFirstUnreadInChat(db, chatId);
          if (fu && fu.count >= JUMP_UNREAD_MIN) setFirstUnread(fu);
        }
      } catch {
        // best-effort — the chip just doesn't show
      }
      void markRead(guid);
    })();
    clearChatNotification(guid); // dismiss any tray notification for this chat
    // Backfill this thread's history from the server on open, so it fills in even if the
    // large initial sync hasn't reached it yet (or was interrupted). The reactive query
    // picks up the upserted messages automatically.
    void ensureChatSynced(guid);
    // Fetch this chat's synced (macOS 26) background if a participant set/changed one — the
    // reactive `chats` query repaints the background once the downloaded uri is written.
    void ensureSyncedBackground(http, getDatabase(), guid);
  }, [guid]);

  const isDev = isDevServer;

  // Fire any scheduled messages that have come due — on open + every 20s while open.
  // The ref is a re-entrancy guard so a slow send (>20s) doesn't let the next tick
  // start a second concurrent run (the DB-level claim is the real lock; this just
  // avoids redundant work).
  const firingRef = useRef(false);
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (firingRef.current) return;
      firingRef.current = true;
      try {
        if (isDev()) {
          await runDueScheduled(getDatabase(), http, Date.now(), (g, t, s) =>
            s ? devSendFakeReply(g, t, s) : devSendFake(g, t),
          );
        } else {
          await fireDueScheduled();
        }
      } finally {
        firingRef.current = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // useCallback-stable: these feed the memoized Composer (and SmartReplyChips), so a reactive
  // tick re-rendering the screen doesn't re-render the composer through fresh closures.
  const onSchedule = useCallback(
    (text: string, scheduledFor: number): void => {
      // Capture the active reply target so a scheduled reply still threads.
      void schedule({ chatGuid: guid, text, scheduledFor, selectedMessageGuid: replyTo?.guid });
      setReplyTo(null);
    },
    [guid, replyTo],
  );

  const onSend = useCallback(
    (
      text: string,
      effectId?: string,
      subject?: string,
      mentions?: { start: number; length: number; address: string }[],
    ): void => {
      // DEV: when on the local dev session, simulate the server round-trip so the
      // optimistic → sent flow is visible without a real Gator server.
      if (editing) {
        const g = editing.guid;
        setEditing(null);
        if (isDev()) void devEditFake(g, text);
        else void editText({ messageGuid: g, newText: text, chatGuid: guid });
        return;
      }
      if (replyTo) {
        if (isDev()) void devSendFakeReply(guid, text, replyTo.guid, effectId);
        else void reply({ chatGuid: guid, text, replyToGuid: replyTo.guid, effectId });
        setReplyTo(null);
        return;
      }
      if (isDev()) void devSendFake(guid, text, effectId);
      else void send({ chatGuid: guid, text, effectId, subject, mentions });
    },
    [guid, editing, replyTo, isDev],
  );

  // The long-press menu / multi-select / swipe-reply handlers (selected, selectedGuids, and
  // threadFor state live in the hook). onLongPressMessage / onSwipeReply / onToggleSelect are
  // STABLE — they feed the memoized MessageList → MessageRow chain (see useMessageActions).
  const {
    selected,
    setSelected,
    selectedGuids,
    setSelectedGuids,
    threadFor,
    setThreadFor,
    editHistory,
    setEditHistory,
    onViewEditHistorySelected,
    onLongPressMessage,
    onSwipeReply,
    onToggleSelect,
    onEnterSelect,
    onBulkCopy,
    onBulkDelete,
    onViewThreadSelected,
    onEditSelected,
    onUnsendSelected,
    onCancelSelected,
    onReact,
    onReplyToSelected,
    onCopySelected,
    onShareSelected,
    onDeleteSelected,
    onForwardSelected,
    onSaveSelected,
    onRemindLater,
  } = useMessageActions({
    guid,
    messages,
    chatTitle: header.data ? resolveTitle(header.data) : 'Gator',
    setReplyTo,
    setEditing,
  });

  // Per-chat draft: restore on open, persist (debounced in the Composer) via kv `draft.<guid>`.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void kvGet(getDatabase(), `draft.${guid}`)
      .then((v) => {
        if (alive) setDraft(v ?? '');
      })
      .catch(() => {
        if (alive) setDraft('');
      });
    return () => {
      alive = false;
    };
  }, [guid]);
  const onDraftChange = useCallback(
    (text: string): void => {
      // Keep the local `draft` state in lockstep with kv. Entering multi-select UNMOUNTS the
      // Composer (bottomStack swaps to the selection bar); on exit it REMOUNTS and restores from
      // `initialText={draft}`. Without this setDraft, `draft` stays frozen at the chat-open value
      // and the remounted Composer comes up stale/empty — then its own unmount flush writes '' back
      // over the real kv draft. The Composer's unmount flush calls this before it unmounts, so
      // `draft` is fresh by the time it remounts.
      setDraft(text);
      void kvSet(getDatabase(), `draft.${guid}`, text).catch(() => {
        // best-effort — losing a draft persist is not worth surfacing
      });
    },
    [guid],
  );

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = useCallback(async (): Promise<PendingAttachment[]> => {
    try {
      // Lazy import: expo-document-picker is a native module, kept off the chat-open path.
      const DocumentPicker = await import('expo-document-picker');
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled || res.assets.length === 0) return [];
      return res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mimeType: a.mimeType ?? 'application/octet-stream',
        size: a.size ?? 0,
      }));
    } catch {
      showDialog('Attach', 'Couldn’t open the file picker.');
      return [];
    }
  }, []);

  // The rest of the Composer's callback props, useCallback-stable for the same memo reason.
  const onSendAttachments = useCallback(
    (items: PendingAttachment[]): void => void sendImages({ chatGuid: guid, images: items }),
    [guid],
  );
  const onCancelReply = useCallback((): void => setReplyTo(null), []);
  const onCancelEdit = useCallback((): void => setEditing(null), []);
  const onTyping = useCallback((active: boolean): void => void sendTyping(guid, active), [guid]);
  const onStartVoice = useCallback((): void => setRecording(true), []);

  // Only let the KeyboardAvoidingView pad WHILE the keyboard is up, so it can't leave a residual
  // gap under the composer after a show/hide cycle (Android edge-to-edge). Same fix as the inbox.
  const kbVisible = useKeyboardVisible();

  // Wallpaper mode: the header/composer float transparent over the image, the list runs UNDER
  // them, and EdgeFade veils dissolve messages into the bar zones instead of hard-clipping them
  // at the list edge. Bar heights are measured (onLayout) since both vary (insets, reply bar,
  // smart-reply chips) — and the wrappers are measured in BOTH modes, so real heights already
  // exist by the time the (async, reactive) wallpaper flag flips the styles. The estimates only
  // cover the very first frames of a cold mount.
  const hasWallpaper = !!backgroundUri;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [headerH, setHeaderH] = useState(0);
  const [bottomBarH, setBottomBarH] = useState(0);
  const topBar = headerH > 0 ? headerH : insets.top + 74;
  const bottomBar = bottomBarH > 0 ? bottomBarH : insets.bottom + 54;

  const headerNode = (
    <ConversationHeader chatGuid={guid} data={header.data} translucent={hasWallpaper} />
  );
  const errorNode = messagesError ? (
    <Text style={styles.errorBanner}>Couldn’t load messages. Pull to refresh or reopen.</Text>
  ) : null;
  // "N unread — jump to first" chip under the header; tap anchors the list on the oldest unread.
  const unreadChipNode =
    firstUnread && !jump ? (
      <Pressable
        onPress={() => {
          setJump({ guid: firstUnread.guid, dateCreated: firstUnread.dateCreated });
          setFirstUnread(null);
        }}
        style={[styles.unreadChip, { backgroundColor: theme.color.tint }]}
        accessibilityRole="button"
        accessibilityLabel={`Jump to the first of ${firstUnread.count} unread messages`}
      >
        <Text style={styles.unreadChipText}>↑ {firstUnread.count} unread — jump to first</Text>
      </Pressable>
    ) : null;
  const listNode = (
    <MessageList
      chatGuid={guid}
      isGroup={isGroup}
      messages={messages}
      accentColor={header.data?.customColor}
      chatService={chatService}
      hasBackground={hasWallpaper}
      topInset={hasWallpaper ? topBar + EDGE_FADE : 0}
      bottomInset={hasWallpaper ? bottomBar + EDGE_FADE : 0}
      onLongPressMessage={onLongPressMessage}
      onSwipeReply={onSwipeReply}
      onRefresh={() => ensureChatSynced(guid)}
      onLoadOlder={onLoadOlder}
      focusGuid={effFocusGuid}
      selectedGuids={selectedGuids}
      onToggleSelect={onToggleSelect}
    />
  );
  // Multi-select replaces the composer with a selection action bar. The Composer's unmount flush
  // persists any in-progress draft to kv AND to `draft` state (via onDraftChange), so exiting
  // select mode remounts the Composer with a fresh `initialText` and restores the draft.
  const selectionBar = selectedGuids ? (
    <View style={[styles.selectBar, { borderTopColor: theme.color.separator }]}>
      <Text style={[styles.selectCount, { color: theme.color.label }]}>
        {selectedGuids.size} selected
      </Text>
      <View style={styles.selectActions}>
        <Pressable onPress={onBulkCopy} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.tint }]}>Copy</Text>
        </Pressable>
        <Pressable onPress={onBulkDelete} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.destructive }]}>Delete</Text>
        </Pressable>
        <Pressable onPress={() => setSelectedGuids(null)} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.tint }]}>Done</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  const bottomStack = selectedGuids ? (
    selectionBar
  ) : (
    <>
      {isTyping ? <TypingBubble /> : null}
      <SmartReplyChips messages={messages} onPick={onSend} />
      <Composer
        placeholder={
          chatService === 'RCS'
            ? 'RCS Message'
            : chatService === 'SMS'
              ? 'Text Message'
              : 'iMessage'
        }
        onSend={onSend}
        onSendAttachments={onSendAttachments}
        onPickFiles={pickFiles}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        editingText={editing?.text ?? null}
        onCancelEdit={onCancelEdit}
        onSchedule={onSchedule}
        onTyping={onTyping}
        onStartVoice={isDev() ? undefined : onStartVoice}
        translucent={hasWallpaper}
        subjectEnabled={sendSubjectLines && chatService === 'iMessage'}
        mentionParticipants={
          isGroup && chatService === 'iMessage' ? (participants ?? NO_PARTICIPANTS) : undefined
        }
        initialText={draft ?? undefined}
        onDraftChange={onDraftChange}
      />
    </>
  );

  return (
    <Screen>
      {backgroundUri ? (
        <Image
          source={{ uri: backgroundUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // Behind the message list; the list container is transparent so this shows
          // through. Bubbles stay readable because the (edited) tokens control contrast.
          pointerEvents="none"
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {/* `padding` consumes the keyboard inset under Android edge-to-edge
          (RN 0.85 / Expo SDK 56 default), keeping the composer above the keyboard. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        {/* ONE structural tree for both modes — the wallpaper flag only switches STYLES (bars go
            absolute, veils appear, the list gains insets). The flag arrives ASYNC (reactive DB
            read, null on first render; a participant-set background can also land mid-chat), so
            branching element types here would remount the whole subtree on the flip — wiping the
            composer draft, staged attachments, and list scroll position.
            Stacking: the bars need zIndex above the veils, which sit above the list — sibling
            order alone would draw the veils over the header (it precedes the list in flow order).
            The absolute bars hang off the unpadded stage view, so the keyboard inset (KAV
            padding) shrinks the stage and the composer rides up with it. */}
        <View style={styles.flex}>
          <View
            style={hasWallpaper ? styles.overlayTop : null}
            onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          >
            {headerNode}
            {errorNode}
            {unreadChipNode}
          </View>
          {listNode}
          {hasWallpaper ? (
            <>
              <EdgeFade
                edge="top"
                height={topBar + EDGE_FADE}
                holdHeight={topBar}
                color={theme.color.background}
              />
              <EdgeFade
                edge="bottom"
                height={bottomBar + EDGE_FADE}
                holdHeight={bottomBar}
                color={theme.color.background}
              />
            </>
          ) : null}
          <View
            style={hasWallpaper ? styles.overlayBottom : null}
            onLayout={(e) => setBottomBarH(e.nativeEvent.layout.height)}
          >
            {bottomStack}
          </View>
        </View>
      </KeyboardAvoidingView>
      {recording ? (
        <LoadErrorBoundary fallback={null} onError={() => setRecording(false)}>
          <Suspense fallback={null}>
            <VoiceRecorder
              onClose={() => setRecording(false)}
              onSend={(uri) => {
                setRecording(false);
                void sendImage({
                  chatGuid: guid,
                  image: {
                    uri,
                    name: uri.split('/').pop() ?? 'voice.m4a',
                    mimeType: 'audio/mp4',
                    size: 0,
                  },
                });
              }}
            />
          </Suspense>
        </LoadErrorBoundary>
      ) : null}
      <MessageActionsOverlay
        selected={selected}
        onClose={() => setSelected(null)}
        onReact={onReact}
        onReply={onReplyToSelected}
        onRemindLater={onRemindLater}
        onEdit={onEditSelected}
        onUnsend={onUnsendSelected}
        onCancelSend={onCancelSelected}
        onCopy={onCopySelected}
        onForward={onForwardSelected}
        onSave={onSaveSelected}
        onShare={onShareSelected}
        onDelete={onDeleteSelected}
        onViewThread={onViewThreadSelected}
        onViewEditHistory={onViewEditHistorySelected}
        onSelect={onEnterSelect}
      />
      <ThreadSheet
        originatorGuid={threadFor}
        onClose={() => setThreadFor(null)}
        onJump={(m) => setJump({ guid: m.guid, dateCreated: m.dateCreated })}
      />
      <EditHistorySheet data={editHistory} onClose={() => setEditHistory(null)} />
      {screenEffect.effect ? (
        <ScreenEffectOverlay effect={screenEffect.effect} onDone={screenEffect.clear} />
      ) : null}
      {__DEV__ ? (
        <Pressable style={styles.devFx} onPress={() => void devInjectEffect(guid)}>
          <Text style={styles.devFxText}>💥</Text>
        </Pressable>
      ) : null}
      {__DEV__ ? (
        <Pressable
          style={styles.devTyping}
          onPress={() =>
            void dispatchRealtimeEvent('typing-indicator', { chatGuid: guid, display: true })
          }
        >
          <Text style={styles.devFxText}>⌨️</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

// Height of the dissolve band the messages fade across, past the bar zone itself.
const EDGE_FADE = 28;

// Stable empty fallback for mentionParticipants — a fresh [] each render would defeat the
// memoized Composer's shallow prop compare.
const NO_PARTICIPANTS: { address: string; name: string }[] = [];

// Show the "jump to oldest unread" chip only for a backlog deep enough that the oldest unread
// message sits above the opening (bottom-anchored) view — a handful of unread is already visible.
const JUMP_UNREAD_MIN = 6;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Wallpaper mode: bars float over the full-height list instead of framing it. zIndex 2 keeps
  // the bar chrome above the EdgeFade veils (zIndex 1), which sit above the in-flow list (0) —
  // the bars precede the list in flow order, so sibling order alone would z-bury them.
  overlayTop: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 },
  overlayBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 2 },
  errorBanner: {
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: 13,
    color: '#FF453A',
    backgroundColor: '#FF453A22',
  },
  // Multi-select action bar (replaces the composer while selecting).
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selectCount: { fontSize: 15, fontWeight: '600' },
  selectActions: { flexDirection: 'row', gap: 24 },
  selectAction: { fontSize: 16, fontWeight: '600' },
  // "N unread — jump to first" pill under the header.
  unreadChip: {
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
  },
  unreadChipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  // DEV-only: inject a send-effect message into this chat to demo effects.
  devFx: {
    position: 'absolute',
    left: 12,
    bottom: 92,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00000088',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // DEV-only: inject a typing-indicator event to demo the typing bubble.
  devTyping: {
    position: 'absolute',
    left: 12,
    bottom: 144,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00000088',
    alignItems: 'center',
    justifyContent: 'center',
  },
  devFxText: { fontSize: 22 },
});
