import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isAggregateRetractionTombstone } from '@core/messages/retraction';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { getDatabase } from '@db/database';
import { listThreadMessages, type MessageRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { buildMessageSnippet, formatTime } from '@utils';
import { useTheme } from '../theme';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

interface ThreadSheetProps {
  /** Exact conversation owner for every row returned by the thread lookup. */
  chatGuid: string;
  /** The thread originator's guid (null → hidden). */
  originatorGuid: string | null;
  onClose: () => void;
  /** Tap a row → jump the chat to that message. */
  onJump: (msg: { guid: string; dateCreated: number }) => void;
}

interface LoadedThread {
  sourceKey: string;
  openLifetime: number;
  rows: MessageRow[];
}

interface CloseRequest {
  sourceKey: string;
  openLifetime: number;
}

/** Keep the account's DB read inside Disconnect's drain boundary. */
async function listThreadForAccount(
  lease: RealtimeDeliveryLease,
  chatGuid: string,
  originatorGuid: string,
): Promise<MessageRow[] | null> {
  let rows: MessageRow[] | undefined;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent()) return;
      rows = await listThreadMessages(getDatabase(), chatGuid, originatorGuid);
    });
    if (status === 'paused' || !lease.isCurrent()) return null;
    return rows ?? null;
  } catch (error) {
    // Disconnect owns a rejection from the retired account. A current-account failure remains
    // available to the component's existing no-results behavior without exposing raw error text.
    if (!lease.isCurrent()) return null;
    throw error;
  }
}

/**
 * "View Thread": the reply chain (originator + every reply) as a bottom sheet — the in-bubble
 * reply quote only shows the immediate parent, so this is where a whole thread is readable.
 * Same plain Modal + Pressable pattern as MessageActionsOverlay. Each controlled opening has a
 * distinct lifetime so callbacks and delayed reads from an earlier opening cannot affect a later
 * opening that happens to use the same originator guid.
 */
export function ThreadSheet({
  chatGuid,
  originatorGuid,
  onClose,
  onJump,
}: ThreadSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const accountLease = useScreenAccountLease();
  const openLifetimeRef = useRef(0);
  // The ref revokes synchronously; committed state gives a reopened sheet fresh callbacks.
  const [renderOpenLifetime, setRenderOpenLifetime] = useState(0);
  const threadSourceKey = originatorGuid ? JSON.stringify([chatGuid, originatorGuid]) : null;
  const lifetimeSourceRef = useRef(threadSourceKey);
  const currentSourceRef = useRef(threadSourceKey);
  const onCloseRef = useRef(onClose);
  const onJumpRef = useRef(onJump);
  const closeRequestedForRef = useRef<CloseRequest | null>(null);
  currentSourceRef.current = threadSourceKey;
  onCloseRef.current = onClose;
  onJumpRef.current = onJump;
  const sourceTransitionPending = lifetimeSourceRef.current !== threadSourceKey;

  const revokeOpenLifetime = useCallback((): number => {
    const nextLifetime = openLifetimeRef.current + 1;
    openLifetimeRef.current = nextLifetime;
    setRenderOpenLifetime(nextLifetime);
    return nextLifetime;
  }, []);

  const requestCloseCurrentThread = useCallback((): void => {
    const current = currentSourceRef.current;
    if (!current) {
      return;
    }
    const currentLifetime = openLifetimeRef.current;
    const requested = closeRequestedForRef.current;
    if (requested?.sourceKey === current && requested.openLifetime === currentLifetime) {
      return;
    }
    const revokedLifetime = revokeOpenLifetime();
    closeRequestedForRef.current = {
      sourceKey: current,
      openLifetime: revokedLifetime,
    };
    onCloseRef.current();
  }, [revokeOpenLifetime]);

  // Exact chat + originator identity defines an opening. Revoke before passive reads run,
  // including A → null → A reopen, direct A → B replacement, or the same originator under a
  // different chat, then let the committed token create fresh row callbacks.
  useLayoutEffect(() => {
    if (lifetimeSourceRef.current === threadSourceKey) return;
    lifetimeSourceRef.current = threadSourceKey;
    closeRequestedForRef.current = null;
    revokeOpenLifetime();
  }, [revokeOpenLifetime, threadSourceKey]);

  // An account switch permanently retires this mounted instance's lease. Close its selected
  // thread synchronously instead of waiting for a later route/store rerender to hide account A.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, requestCloseCurrentThread),
    [accountLease, requestCloseCurrentThread],
  );

  // The invalidation subscription handles a live handoff synchronously. This layout check also
  // covers a sheet mounted with a lease that was already retired.
  useLayoutEffect(() => {
    if (threadSourceKey && !accountLease.isCurrent()) requestCloseCurrentThread();
  }, [accountLease, requestCloseCurrentThread, threadSourceKey]);

  const accountCurrent = accountLease.isCurrent();
  const contentUnavailable = !accountCurrent || sourceTransitionPending;

  const threadGrantIsCurrent = useCallback(
    (openLifetime: number, expectedSourceKey: string): boolean => {
      const closeRequest = closeRequestedForRef.current;
      return (
        accountLease.isCurrent() &&
        openLifetimeRef.current === openLifetime &&
        lifetimeSourceRef.current === expectedSourceKey &&
        currentSourceRef.current === expectedSourceKey &&
        !(
          closeRequest?.sourceKey === expectedSourceKey &&
          closeRequest.openLifetime === openLifetime
        )
      );
    },
    [accountLease],
  );

  const reactiveThread = useReactiveQuery<LoadedThread | null>(
    async () => {
      const sourceChatGuid = chatGuid;
      const sourceOriginatorGuid = originatorGuid;
      const sourceKey = threadSourceKey;
      const loadOpenLifetime = renderOpenLifetime;
      if (
        !sourceOriginatorGuid ||
        !sourceKey ||
        contentUnavailable ||
        !threadGrantIsCurrent(loadOpenLifetime, sourceKey)
      ) {
        return null;
      }
      const rows = await listThreadForAccount(accountLease, sourceChatGuid, sourceOriginatorGuid);
      if (rows == null || !threadGrantIsCurrent(loadOpenLifetime, sourceKey)) {
        return null;
      }
      return {
        sourceKey,
        openLifetime: loadOpenLifetime,
        rows,
      };
    },
    ['messages', 'handles'],
    [chatGuid, originatorGuid, renderOpenLifetime, contentUnavailable, threadSourceKey],
    { enabled: !!threadSourceKey && !contentUnavailable },
  );

  const closeRequest = closeRequestedForRef.current;
  const closeRequestedForCurrent =
    closeRequest?.sourceKey === threadSourceKey && closeRequest.openLifetime === renderOpenLifetime;

  if (!threadSourceKey || contentUnavailable || closeRequestedForCurrent) {
    return <></>;
  }

  // Hide a prior thread's rows immediately when the sheet closes or changes originator. The
  // matching async load makes them visible again without a synchronous reset effect.
  const rows =
    reactiveThread.data?.sourceKey === threadSourceKey &&
    reactiveThread.data.openLifetime === renderOpenLifetime
      ? reactiveThread.data.rows
      : [];
  const rowOpenLifetime = renderOpenLifetime;
  const rowSourceKey = threadSourceKey;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={requestCloseCurrentThread}>
      <Pressable
        testID="thread-sheet-backdrop"
        style={styles.backdrop}
        onPress={requestCloseCurrentThread}
      >
        <Pressable
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          // Swallow taps inside the sheet so they don't dismiss through to the backdrop.
          onPress={() => undefined}
        >
          <Text style={[styles.title, { color: theme.color.label }]}>
            Thread · {Math.max(rows.length - 1, 0)} {rows.length - 1 === 1 ? 'reply' : 'replies'}
          </Text>
          <ScrollView style={styles.list}>
            {rows.map((m, i) => {
              const who = m.isFromMe === 1 ? 'You' : (m.senderName ?? 'Unknown');
              return (
                <Pressable
                  key={m.guid}
                  onPress={() => {
                    if (!threadGrantIsCurrent(rowOpenLifetime, rowSourceKey)) return;
                    requestCloseCurrentThread();
                    if (m.dateCreated != null) {
                      onJumpRef.current({ guid: m.guid, dateCreated: m.dateCreated });
                    }
                  }}
                  style={[
                    styles.row,
                    i > 0 && {
                      borderTopColor: theme.color.separator,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Jump to ${who}'s message`}
                >
                  <View style={styles.rowHead}>
                    <Text style={[styles.who, { color: theme.color.secondaryLabel }]}>
                      {who}
                      {i === 0 ? ' · original' : ''}
                    </Text>
                    <Text style={[styles.when, { color: theme.color.tertiaryLabel }]}>
                      {formatTime(m.dateCreated ?? 0)}
                    </Text>
                  </View>
                  <Text numberOfLines={3} style={[styles.body, { color: theme.color.label }]}>
                    {buildMessageSnippet({
                      text: m.text,
                      subject: m.subject,
                      hasAttachments: m.hasAttachments,
                      hasVisibleAttachments: m.hasVisibleAttachments,
                      attachmentDescription: m.attachmentDescription,
                      balloonBundleId: m.balloonBundleId,
                      isRetracted: isAggregateRetractionTombstone(m),
                    }) || 'Message'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '70%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  list: { flexGrow: 0 },
  row: { paddingVertical: 10 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  who: { fontSize: 12, fontWeight: '600' },
  when: { fontSize: 12 },
  body: { fontSize: 15, lineHeight: 20 },
});
