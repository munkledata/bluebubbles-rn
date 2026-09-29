import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { IMESSAGE_EFFECT_OPTIONS } from '@core/effects';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';

interface EffectPickerProps {
  visible: boolean;
  onClose: () => void;
  onPick: (effectId: string) => void;
}

/** Small Android-safe in-app picker; unlike a system Alert it is not limited to three actions. */
export function EffectPicker({ visible, onClose, onPick }: EffectPickerProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
        <Pressable
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + 12,
              backgroundColor: theme.color.background,
            },
          ]}
          onPress={() => {}}
        >
          <Text style={[styles.title, { color: theme.color.label }]}>Send with effect</Text>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.sections}
            keyboardShouldPersistTaps="handled"
          >
            {(['bubble', 'screen'] as const).map((kind) => (
              <View key={kind} style={styles.sectionBlock}>
                <Text style={[styles.section, { color: theme.color.secondaryLabel }]}>
                  {kind === 'bubble' ? 'BUBBLE' : 'SCREEN'}
                </Text>
                <View style={styles.grid}>
                  {IMESSAGE_EFFECT_OPTIONS.filter((effect) => effect.kind === kind).map(
                    (effect) => (
                      <Pressable
                        key={effect.id}
                        onPress={() => {
                          onPick(effect.id);
                          onClose();
                        }}
                        style={[styles.chip, { backgroundColor: theme.color.secondaryBackground }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Send with ${effect.label} effect`}
                      >
                        <Text style={[styles.chipText, { color: theme.color.label }]}>
                          {effect.label}
                        </Text>
                      </Pressable>
                    ),
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
          <Pressable
            onPress={onClose}
            style={[styles.cancel, { backgroundColor: theme.color.secondaryBackground }]}
            accessibilityRole="button"
            accessibilityLabel="Cancel effect picker"
          >
            <Text style={[styles.cancelText, { color: theme.color.tint }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  scroll: { maxHeight: 360 },
  sections: { gap: 16 },
  sectionBlock: { gap: 8 },
  section: { fontSize: 12, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 20 },
  chipText: { fontSize: 15, fontWeight: '500' },
  cancel: { alignItems: 'center', borderRadius: 12, paddingVertical: 13 },
  cancelText: { fontSize: 16, fontWeight: '600' },
});
