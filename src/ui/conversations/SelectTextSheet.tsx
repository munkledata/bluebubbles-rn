import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

interface SelectTextSheetProps {
  /** The message text to select from; `null` = closed. */
  text: string | null;
  onClose: () => void;
}

/**
 * "Select Text": a message's text in a sheet where a long-press selects any part of it, with the
 * phone's own Copy / Share / Select all toolbar. Read-only; nothing here sends or edits.
 *
 * The selectable text deliberately has no pressable ancestor: on Android a parent touchable can
 * take the long-press that starts a selection. The tap-outside-to-close area is a sibling behind
 * the sheet instead.
 */
export function SelectTextSheet({ text, onClose }: SelectTextSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (text === null) return <></>;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable
          testID="select-text-backdrop"
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          accessibilityViewIsModal
        >
          <Text style={[styles.title, { color: theme.color.label }]}>Select Text</Text>
          <ScrollView style={styles.scroll}>
            <Text
              testID="select-text-body"
              selectable
              selectionColor={theme.color.tint}
              style={[styles.body, { color: theme.color.label }]}
            >
              {text}
            </Text>
          </ScrollView>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done"
            style={styles.done}
            hitSlop={8}
          >
            <Text style={[styles.doneText, { color: theme.color.tint }]}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '80%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  scroll: { flexGrow: 0 },
  body: { fontSize: 17, lineHeight: 24, paddingVertical: 8 },
  done: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 24, marginTop: 4 },
  doneText: { fontSize: 16, fontWeight: '600' },
});
