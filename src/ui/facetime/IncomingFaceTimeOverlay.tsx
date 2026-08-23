import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIncomingFaceTime } from '@features/facetime/useIncomingFaceTime';
import { useFaceTimeStore } from '@state/faceTimeStore';

/**
 * Full-screen in-app ring for an INCOMING FaceTime call (Phase 4). Shows Answer/Decline;
 * Answer hands off to the external-browser call overlay. Hidden once a call is active (the
 * handoff overlay takes over). A touch-catching modal (unlike the send-effect overlay) — it blocks
 * the screen behind until answered/declined.
 */
export function IncomingFaceTimeOverlay(): React.JSX.Element | null {
  const incoming = useFaceTimeStore((s) => s.incoming);
  const activeCall = useFaceTimeStore((s) => s.call);
  const generation = useFaceTimeStore((s) => s.generation);
  const { answer, decline } = useIncomingFaceTime();
  const insets = useSafeAreaInsets();

  // Don't ring over an active call; nothing to show otherwise.
  if (!incoming || activeCall) return null;

  const name = incoming.callerName;
  const subtitle = incoming.isAudio ? 'FaceTime Audio…' : 'FaceTime Video…';
  const capturedIncoming = incoming;
  const resolveCurrentIncoming = (): typeof capturedIncoming | null => {
    const current = useFaceTimeStore.getState();
    if (
      current.generation !== generation ||
      current.call !== null ||
      current.incoming?.uuid !== capturedIncoming.uuid
    ) {
      return null;
    }
    return current.incoming;
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { paddingTop: insets.top + 80 }]}>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      <View style={[styles.row, { paddingBottom: insets.bottom + 40 }]}>
        <Pressable
          style={[styles.btn, styles.decline]}
          onPress={() => {
            const current = resolveCurrentIncoming();
            if (current) decline(current.uuid);
          }}
          accessibilityRole="button"
          accessibilityLabel="Decline FaceTime call"
        >
          <Text style={styles.btnText}>Decline</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.answer]}
          onPress={() => {
            const current = resolveCurrentIncoming();
            if (current) void answer(current);
          }}
          accessibilityRole="button"
          accessibilityLabel="Answer FaceTime call"
        >
          <Text style={styles.btnText}>Answer</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#1C1C1E', zIndex: 110, justifyContent: 'space-between' },
  info: { alignItems: 'center', gap: 8 },
  name: { color: '#fff', fontSize: 30, fontWeight: '600', maxWidth: '90%' },
  subtitle: { color: '#EBEBF599', fontSize: 17 },
  row: { flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center' },
  btn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  decline: { backgroundColor: '#FF3B30' },
  answer: { backgroundColor: '#34C759' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
