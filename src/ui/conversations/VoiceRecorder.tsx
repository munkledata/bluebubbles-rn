import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

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
}: {
  onClose: () => void;
  onSend: (uri: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);
  const finished = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        onClose();
        return;
      }
      try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch {
        /* best-effort audio mode */
      }
      // Re-check after every await: the user may have cancelled/sent (finished) or the
      // modal may have unmounted before recording actually started.
      if (!active || finished.current) return;
      await recorder.prepareToRecordAsync();
      if (!active || finished.current) return;
      recorder.record();
      started.current = true;
    })();
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      active = false;
      clearInterval(id);
      // Stop a still-running recording on unmount (system back / navigation) so the
      // encoder flushes and the native recorder is released cleanly.
      if (started.current && !finished.current) void recorder.stop().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async (send: boolean): Promise<void> => {
    if (finished.current) return; // idempotent — ignore a double Cancel/Send tap
    finished.current = true;
    let uri: string | null = null;
    if (started.current) {
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch {
        /* ignore */
      }
    }
    if (send && uri) onSend(uri);
    onClose();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => void finish(false)}>
      <Pressable style={styles.backdrop} onPress={() => void finish(false)}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.rec, { color: theme.color.destructive }]}>
            ● Recording {fmt(elapsed)}
          </Text>
          <View style={styles.row}>
            <Pressable onPress={() => void finish(false)} hitSlop={8}>
              <Text style={[styles.cancel, { color: theme.color.secondaryLabel }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void finish(true)}
              style={[styles.send, { backgroundColor: theme.color.tint }]}
            >
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { padding: 24, paddingBottom: 40, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  rec: { fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cancel: { fontSize: 16 },
  send: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 20 },
  sendText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
