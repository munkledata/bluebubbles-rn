import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EFFECT_OPTIONS } from '@core/effects';
import { useTheme } from '../../theme';

interface EffectPickerProps {
  visible: boolean;
  onClose: () => void;
  /** Send the pending text with this effect id (or undefined for none). */
  onPick: (effectId: string | undefined) => void;
}

/**
 * Effect picker shown by long-pressing the composer send button. Tapping an
 * effect sends the typed message with that send-effect. Plain Modal + Pressable
 * (no gesture-handler), consistent with the message-actions overlay.
 */
export function EffectPicker({ visible, onClose, onPick }: EffectPickerProps): React.JSX.Element {
  const theme = useTheme();
  const bubbles = EFFECT_OPTIONS.filter((e) => e.kind === 'bubble');
  const screens = EFFECT_OPTIONS.filter((e) => e.kind === 'screen');

  const pick = (id: string | undefined): void => {
    onPick(id);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: theme.color.background }]}>
          <Text style={[styles.title, { color: theme.color.label }]}>Send with effect</Text>
          <Text style={[styles.section, { color: theme.color.secondaryLabel }]}>BUBBLE</Text>
          <View style={styles.grid}>
            {bubbles.map((e) => (
              <Chip key={e.id} label={e.label} onPress={() => pick(e.id)} />
            ))}
          </View>
          <Text style={[styles.section, { color: theme.color.secondaryLabel }]}>SCREEN</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.grid}>
              {screens.map((e) => (
                <Chip key={e.id} label={e.label} onPress={() => pick(e.id)} />
              ))}
            </View>
          </ScrollView>
          <Pressable onPress={() => pick(undefined)} style={styles.none}>
            <Text style={[styles.noneText, { color: theme.color.tint }]}>Send without effect</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// Module-scope (not nested in EffectPicker): a nested component is a fresh TYPE every render,
// which would unmount/remount every chip on each parent render.
function Chip({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: theme.color.secondaryBackground }]}
    >
      <Text style={[styles.chipText, { color: theme.color.label }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28, gap: 10 },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center', marginBottom: 4 },
  section: { fontSize: 12, marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
  chipText: { fontSize: 15, fontWeight: '500' },
  none: { alignItems: 'center', paddingTop: 10 },
  noneText: { fontSize: 16 },
});
