import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, StyleSheet, Text } from 'react-native';
import { parseReactionType, type ReactionBaseType } from '@core/reactions/reactionType';
import type { MessagePreview } from '@db/repositories';
import { dispatchRealtimeEvent, http, markRead, sendTyping } from '@/services';
import { getDatabase } from '@db/database';
import { clearChatNotification } from '@/services/notifications/notifeeService';
import {
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
  devSendFakeImage,
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
  MessageActionsOverlay,
  MessageList,
  Screen,
  ScreenEffectOverlay,
  SmartReplyChips,
  TypingBubble,
  type SelectedMessage,
} from '@ui';
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';
import { useTypingStore } from '@state/typingStore';
import { isGroupRow, resolveTitle } from '@utils';

// Lazy: expo-audio (native) is only pulled in when the user actually records a voice memo,
// so the chat opens fine on a build that hasn't linked the module yet.
const VoiceRecorder = lazy(() =>
  import('@ui/conversations/VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })),
);

/** Phase 4 conversation view: reactive message list + composer with optimistic send. */
export default function ChatScreen(): React.JSX.Element {
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const header = useChatHeader(guid);
  const isGroup = header.data ? isGroupRow(header.data) : false;
  // ONE message subscription for the whole screen — fed to the list, smart-reply
  // chips, and the screen-effect trigger (avoids 3× the reactive query work).
  const { data: messagesData, error: messagesError } = useMessages(guid);
  const messages = messagesData ?? [];
  const isTyping = useTypingStore((s) => !!s.typing[guid]);
  const markedRef = useRef(false);
  const [selected, setSelected] = useState<SelectedMessage | null>(null);
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{ guid: string; text: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const screenEffect = useNewScreenEffect(guid, messages);

  useEffect(() => {
    if (markedRef.current || !guid) return;
    markedRef.current = true;
    void markRead(guid);
    clearChatNotification(guid); // dismiss any tray notification for this chat
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
      else void editText({ messageGuid: g, newText: text });
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
          else void unsend({ messageGuid: g });
        },
      },
    ]);
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

  const attachPhotos = async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (res.canceled || res.assets.length === 0) return;
    void sendImages({
      chatGuid: guid,
      images: res.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName ?? a.uri.split('/').pop() ?? 'image.jpg',
        mimeType: a.mimeType ?? 'image/jpeg',
        size: a.fileSize ?? 0,
        width: a.width,
        height: a.height,
      })),
    });
  };

  const attachFiles = async (): Promise<void> => {
    try {
      // Lazy import: expo-document-picker is a native module, kept off the chat-open path.
      const DocumentPicker = await import('expo-document-picker');
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled || res.assets.length === 0) return;
      void sendImages({
        chatGuid: guid,
        images: res.assets.map((a) => ({
          uri: a.uri,
          name: a.name,
          mimeType: a.mimeType ?? 'application/octet-stream',
          size: a.size ?? 0,
        })),
      });
    } catch {
      Alert.alert('Attach', 'Couldn’t open the file picker.');
    }
  };

  const onAttach = (): void => {
    if (isDev()) {
      void devSendFakeImage(guid);
      return;
    }
    Alert.alert('Attach', undefined, [
      { text: 'Photos', onPress: () => void attachPhotos() },
      { text: 'Files', onPress: () => void attachFiles() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <Screen>
      {/* `padding` consumes the keyboard inset under Android edge-to-edge
          (RN 0.85 / Expo SDK 56 default), keeping the composer above the keyboard. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ConversationHeader chatGuid={guid} />
        {messagesError ? (
          <Text style={styles.errorBanner}>Couldn’t load messages. Pull to refresh or reopen.</Text>
        ) : null}
        <MessageList
          chatGuid={guid}
          isGroup={isGroup}
          messages={messages}
          accentColor={header.data?.customColor}
          onLongPressMessage={onLongPressMessage}
        />
        {isTyping ? <TypingBubble /> : null}
        <SmartReplyChips messages={messages} onPick={onSend} />
        <Composer
          onSend={onSend}
          onAttach={() => void onAttach()}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editingText={editing?.text ?? null}
          onCancelEdit={() => setEditing(null)}
          onSchedule={onSchedule}
          onTyping={(active) => sendTyping(guid, active)}
          onStartVoice={isDev() ? undefined : () => setRecording(true)}
        />
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
