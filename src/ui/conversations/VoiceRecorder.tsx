import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { readableTextOn, useTheme } from '../theme';

function fmt(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
}

/**
 * Voice-memo recorder overlay: starts recording on mount, shows elapsed time, and
 * sends/cancels. Lazy-mounted (only when the mic is tapped) so `expo-audio` stays off the
 * chat-open path. The recorded file is sent as an audio attachment via the normal pipeline.
 */
export function VoiceRecorder({
  onClose,
  onSend,
  onPermissionDenied,
  onPermissionError,
  onStartError,
}: {
  onClose: () => void;
  /**
   * Only explicit `true` proves a durable queue row owns the recording; every other path retains
   * it for another try, except 'too-large', which no retry can fix.
   */
  onSend: (uri: string) => Promise<boolean | 'too-large'>;
  onPermissionDenied?: () => void;
  onPermissionError?: () => void;
  /** The recorder could not start (for example, another app holds the microphone). */
  onStartError?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [elapsed, setElapsed] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [recordingReady, setRecordingReady] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const started = useRef(false);
  const finished = useRef(false);
  const stopPending = useRef(false);
  const sendPending = useRef(false);
  const retainedUri = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void (async () => {
      let perm: Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>;
      try {
        perm = await requestRecordingPermissionsAsync();
      } catch {
        if (!active || finished.current) return;
        finished.current = true;
        onPermissionError?.();
        onClose();
        return;
      }
      if (!active || finished.current) return;
      if (!perm.granted) {
        finished.current = true;
        onPermissionDenied?.();
        onClose();
        return;
      }
      try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch {
        /* best-effort audio mode */
      }
      // Re-check after every await: the user may have cancelled/sent (finished) or the modal may
      // have unmounted before recording actually started.
      if (!active || finished.current) return;
      try {
        await recorder.prepareToRecordAsync();
        if (!active || finished.current) return;
        recorder.record();
      } catch {
        // Without this the sheet froze on 'Recording 0:00' with nothing to send.
        if (!active || finished.current) return;
        finished.current = true;
        onStartError?.();
        onClose();
        return;
      }
      started.current = true;
      setRecordingReady(true);
      setRecordingActive(true);
    })();
    return () => {
      active = false;
      // Stop a still-running recording on unmount (system back / navigation) so the
      // encoder flushes and the native recorder is released cleanly.
      if (started.current && !stopPending.current && !finished.current) {
        void recorder.stop().catch(() => undefined);
      }
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recordingActive) return;
    const id = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [recordingActive]);

  const stopAndRetain = async (): Promise<string | null> => {
    if (retainedUri.current) return retainedUri.current;
    if (!started.current || stopPending.current) return null;
    stopPending.current = true;
    try {
      await recorder.stop();
      started.current = false;
      const uri = recorder.uri;
      retainedUri.current = uri;
      return uri;
    } catch {
      return null;
    } finally {
      stopPending.current = false;
    }
  };

  const discard = async (): Promise<void> => {
    if (finished.current || sendPending.current) return;
    finished.current = true;
    if (started.current && !stopPending.current) {
      stopPending.current = true;
      try {
        await recorder.stop();
      } catch {
        /* best-effort native release */
      } finally {
        started.current = false;
        stopPending.current = false;
      }
    }
    onClose();
  };

  const send = async (): Promise<void> => {
    if (finished.current || sendPending.current || !recordingReady) return;
    sendPending.current = true;
    setSubmitting(true);
    setSendFailed(false);
    setRecordingActive(false);

    const uri = await stopAndRetain();
    if (!mounted.current || finished.current) return;
    let admitted = false;
    let rejectedAsTooLarge = false;
    if (uri) {
      try {
        const result = await onSend(uri);
        admitted = result === true;
        rejectedAsTooLarge = result === 'too-large';
      } catch {
        admitted = false;
      }
    }

    if (!mounted.current || finished.current) return;
    if (admitted) {
      finished.current = true;
      onClose();
      return;
    }

    sendPending.current = false;
    if (!mounted.current || finished.current) return;
    setSubmitting(false);
    setSendFailed(true);
    setTooLarge(rejectedAsTooLarge);
  };

  const requestSystemCancel = (): void => {
    if (sendPending.current) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (!started.current && !retainedUri.current) {
      void discard();
      return;
    }
    setConfirmDiscard(true);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={requestSystemCancel}>
      <Pressable style={styles.backdrop} onPress={requestSystemCancel}>
        <Pressable
          style={[styles.sheet, { backgroundColor: theme.color.secondaryBackground }]}
          onPress={(event) => event.stopPropagation()}
        >
          {confirmDiscard ? (
            <>
              <Text style={[styles.confirmTitle, { color: theme.color.label }]}>
                Discard this recording?
              </Text>
              <View style={styles.row}>
                <Pressable onPress={() => setConfirmDiscard(false)} hitSlop={8}>
                  <Text style={[styles.cancel, { color: theme.color.tint }]}>Keep Recording</Text>
                </Pressable>
                <Pressable onPress={() => void discard()} hitSlop={8}>
                  <Text style={[styles.cancel, { color: theme.color.destructive }]}>Discard</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.rec, { color: theme.color.destructive }]}>
                {submitting
                  ? 'Queueing recording…'
                  : sendFailed
                    ? `Recording ready ${fmt(elapsed)}`
                    : `● Recording ${fmt(elapsed)}`}
              </Text>
              {sendFailed ? (
                <Text style={[styles.status, { color: theme.color.secondaryLabel }]}>
                  {tooLarge
                    ? 'This recording is too long to send. Record a shorter one.'
                    : 'It wasn’t queued. You can try again without re-recording.'}
                </Text>
              ) : null}
              <View style={styles.row}>
                <Pressable onPress={() => void discard()} disabled={submitting} hitSlop={8}>
                  <Text style={[styles.cancel, { color: theme.color.secondaryLabel }]}>
                    {sendFailed ? 'Discard' : 'Cancel'}
                  </Text>
                </Pressable>
                {tooLarge ? null : (
                  <Pressable
                    onPress={() => void send()}
                    disabled={submitting || !recordingReady}
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: submitting || !recordingReady,
                      busy: submitting,
                    }}
                    style={[
                      styles.send,
                      { backgroundColor: theme.color.tint, opacity: submitting ? 0.55 : 1 },
                    ]}
                  >
                    <Text style={[styles.sendText, { color: readableTextOn(theme.color.tint) }]}>
                      {sendFailed ? 'Try Again' : submitting ? 'Queueing…' : 'Send'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { padding: 24, paddingBottom: 40, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  rec: { fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 20 },
  status: { fontSize: 14, textAlign: 'center', marginTop: -10, marginBottom: 20 },
  confirmTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cancel: { fontSize: 16 },
  send: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 20 },
  sendText: { fontSize: 16, fontWeight: '600' },
});
