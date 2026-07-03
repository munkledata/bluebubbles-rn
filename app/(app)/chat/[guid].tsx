import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseReactionType, type ReactionBaseType } from '@core/reactions/reactionType';
import type { MessagePreview } from '@db/repositories';
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
  cancelOutgoing,
  editText,
  fireDueScheduled,
  react,
  reply,
  runDueScheduled,
  schedule,
  send,
  sendImage,
  sendImages,
  unsend,
} from '@/services/send';
import {
  devEditFake,
  devInjectEffect,
  devSendFake,
  devSendFakeReaction,
  devSendFakeReply,
  devUnsendFake,
} from '@features/conversations/devSeed';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useMessages } from '@features/conversations/useMessages';
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
import { scheduleReminder } from '@/services/notifications/remindersService';
import { isDevServer } from '@utils/isDev';
import {
  Composer,
  ConversationHeader,
  EdgeFade,
  MessageActionsOverlay,
  MessageList,
  Screen,
  ScreenEffectOverlay,
  SmartReplyChips,
  TypingBubble,
  useTheme,
  type PendingAttachment,
  type SelectedMessage,
} from '@ui';
import { ChatThemeProvider, useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';
import { useTypingStore } from '@state/typingStore';
import { isGroupRow, resolveTitle } from '@utils';

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
  // When focusing a search hit, widen the load down to its date (and raise the cap) so it's present
  // to scroll to; otherwise the normal recent window. ONE message subscription for the whole screen
  // — fed to the list, smart-reply chips, and the screen-effect trigger (avoids 3× the query work).
  const sinceDateNum = focusDate ? Number(focusDate) : NaN;
  const sinceDate = Number.isFinite(sinceDateNum) ? sinceDateNum : undefined;
  const { data: messagesData, error: messagesError } = useMessages(
    guid,
    sinceDate != null ? 1500 : 250,
    sinceDate,
  );
  const messages = messagesData ?? [];
  const isTyping = useTypingStore((s) => !!s.typing[guid]);
  const markedRef = useRef(false);
  const [selected, setSelected] = useState<SelectedMessage | null>(null);
  const router = useRouter();
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{ guid: string; text: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const screenEffect = useNewScreenEffect(guid, messages);

  useEffect(() => {
    if (markedRef.current || !guid) return;
    markedRef.current = true;
    void markRead(guid);
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

  const onSchedule = (text: string, scheduledFor: number): void => {
    // Capture the active reply target so a scheduled reply still threads.
    void schedule({ chatGuid: guid, text, scheduledFor, selectedMessageGuid: replyTo?.guid });
    setReplyTo(null);
  };

  const onSend = (text: string, effectId?: string): void => {
    // DEV: when on the local dev session, simulate the server round-trip so the
    // optimistic → sent flow is visible without a real BlueBubbles server.
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
    else void send({ chatGuid: guid, text, effectId });
  };

  // Long-press a bubble → open the tapback/reply/edit menu. Stable so the
  // memoized message rows aren't re-rendered by a fresh closure each render.
  const onLongPressMessage = useCallback((msg: EnrichedMessage): void => {
    const mine = msg.reactions
      .filter((r) => r.isFromMe)
      .map((r) => r.baseType)
      .filter((t): t is ReactionBaseType => !!parseReactionType(t));
    setSelected({
      guid: msg.guid,
      text: msg.text,
      isFromMe: msg.isFromMe === 1,
      senderName: msg.senderName,
      mine,
      dateCreated: msg.dateCreated,
      isRetracted: !!msg.dateRetracted,
      isTemp: msg.guid.startsWith('temp-'),
      sendState: msg.sendState,
      attachments: (msg.attachments ?? []).map((a) => ({
        guid: a.guid,
        localPath: a.localPath,
        mimeType: a.mimeType,
      })),
    });
  }, []);

  const onEditSelected = (): void => {
    if (!selected) return;
    setReplyTo(null);
    setEditing({ guid: selected.guid, text: selected.text ?? '' });
  };

  const onUnsendSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    Alert.alert('Unsend message?', 'This removes it for you and retracts it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unsend',
        style: 'destructive',
        onPress: () => {
          if (isDev()) void devUnsendFake(g);
          else void unsend({ messageGuid: g, chatGuid: guid });
        },
      },
    ]);
  };

  const onCancelSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    const sending = selected.sendState === 'sending';
    Alert.alert(
      sending ? 'Cancel sending?' : 'Remove message?',
      sending
        ? 'Stop sending this message and remove it.'
        : 'Remove this unsent message from the conversation.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: sending ? 'Cancel Sending' : 'Remove',
          style: 'destructive',
          onPress: () => void cancelOutgoing(g),
        },
      ],
    );
  };

  const onReact = (reaction: string): void => {
    if (!selected) return;
    const args = {
      chatGuid: guid,
      targetGuid: selected.guid,
      reaction,
      selectedMessageText: selected.text ?? '',
    };
    if (isDev()) void devSendFakeReaction(guid, selected.guid, reaction);
    else void react(args);
  };

  const onReplyToSelected = (): void => {
    if (!selected) return;
    setReplyTo({
      guid: selected.guid,
      text: selected.text,
      isFromMe: selected.isFromMe ? 1 : 0,
      senderName: selected.senderName,
      hasAttachments: 0,
    });
  };

  const onCopySelected = (): void => {
    if (selected?.text) void Clipboard.setStringAsync(selected.text);
  };

  // Forward: open the new-message composer pre-filled with this message's text (parity with the
  // old app's "Forward" → chat creator). Attachment forwarding is not yet supported.
  const onForwardSelected = (): void => {
    if (!selected?.text) return;
    router.push({ pathname: '/new-chat', params: { forwardText: selected.text } });
  };

  // Save the message's attachment(s) to the device gallery. Saves any already-downloaded local
  // file; if none is downloaded yet, tells the user to open it first (which triggers the download).
  const onSaveSelected = (): void => {
    const atts = selected?.attachments ?? [];
    if (atts.length === 0) return;
    void (async () => {
      try {
        const perm = await MediaLibrary.requestPermissionsAsync();
        if (perm.status !== 'granted') {
          Alert.alert('Save', 'Photos permission is required to save attachments.');
          return;
        }
        let saved = 0;
        for (const a of atts) {
          const p = a.localPath;
          if (p && (p.startsWith('file://') || p.startsWith('/'))) {
            await MediaLibrary.saveToLibraryAsync(p);
            saved += 1;
          }
        }
        Alert.alert(
          'Save',
          saved > 0
            ? `Saved ${saved} ${saved === 1 ? 'item' : 'items'} to Photos.`
            : 'Open the attachment first to download it, then try Save again.',
        );
      } catch {
        Alert.alert('Save', 'Couldn’t save the attachment.');
      }
    })();
  };

  const onRemindLater = (): void => {
    if (!selected) return;
    const msg = selected;
    void (async () => {
      const when = await pickFutureDateTime();
      if (when == null) return;
      try {
        await scheduleReminder(getDatabase(), {
          chatGuid: guid,
          messageGuid: msg.guid,
          chatTitle: header.data ? resolveTitle(header.data) : 'BlueBubbles',
          messagePreview: msg.text,
          senderName: msg.senderName,
          scheduledFor: when,
          now: Date.now(),
        });
        Alert.alert('Reminder set', 'You’ll be reminded about this message.');
      } catch {
        Alert.alert('Reminder', 'Couldn’t set the reminder.');
      }
    })();
  };

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = async (): Promise<PendingAttachment[]> => {
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
      Alert.alert('Attach', 'Couldn’t open the file picker.');
      return [];
    }
  };

  // Only let the KeyboardAvoidingView pad WHILE the keyboard is up, so it can't leave a residual
  // gap under the composer after a show/hide cycle (Android edge-to-edge). Same fix as the inbox.
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKbVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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

  const headerNode = <ConversationHeader chatGuid={guid} translucent={hasWallpaper} />;
  const errorNode = messagesError ? (
    <Text style={styles.errorBanner}>Couldn’t load messages. Pull to refresh or reopen.</Text>
  ) : null;
  const listNode = (
    <MessageList
      chatGuid={guid}
      isGroup={isGroup}
      messages={messages}
      accentColor={header.data?.customColor}
      hasBackground={hasWallpaper}
      topInset={hasWallpaper ? topBar + EDGE_FADE : 0}
      bottomInset={hasWallpaper ? bottomBar + EDGE_FADE : 0}
      onLongPressMessage={onLongPressMessage}
      onRefresh={() => ensureChatSynced(guid)}
      focusGuid={focusGuid}
    />
  );
  const bottomStack = (
    <>
      {isTyping ? <TypingBubble /> : null}
      <SmartReplyChips messages={messages} onPick={onSend} />
      <Composer
        onSend={onSend}
        onSendAttachments={(items) => void sendImages({ chatGuid: guid, images: items })}
        onPickFiles={pickFiles}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editingText={editing?.text ?? null}
        onCancelEdit={() => setEditing(null)}
        onSchedule={onSchedule}
        onTyping={(active) => sendTyping(guid, active)}
        onStartVoice={isDev() ? undefined : () => setRecording(true)}
        translucent={hasWallpaper}
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
      />
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
