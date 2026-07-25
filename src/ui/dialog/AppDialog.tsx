import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useDialogStore, type DialogButton } from './dialogStore';

/**
 * The single host for the app-wide themed dialog (see {@link useDialogStore}). Mounted once at the
 * root, inside ThemeProvider. Renders an iOS-style centered alert card — replacing the native
 * `Alert.alert` Material dialog — with 2 buttons side-by-side and 1-or-3+ stacked, matching iOS.
 * The backdrop does NOT dismiss (an iOS alert requires a button choice); Android back = the cancel
 * button (or the last button) so the dialog can't get stuck.
 */
export function AppDialog(): React.JSX.Element | null {
  const theme = useTheme();
  const current = useDialogStore((s) => s.current);
  const dismiss = useDialogStore((s) => s.dismiss);
  if (!current) return null;

  const { title, message, buttons } = current;
  const horizontal = buttons.length === 2;

  const press = (b: DialogButton): void => {
    // Dismiss FIRST so a handler that opens another dialog enqueues onto a cleared slot.
    dismiss();
    b.onPress?.();
  };

  /**
   * Android hardware BACK. Back means "get me out of here" — it must never be read as consent.
   *
   * The fallback to the LAST button (for dialogs with no explicit cancel) is kept so an
   * informational one-button dialog still runs its acknowledge handler. But a `destructive`
   * button is never auto-pressed: on a dialog whose only/last button deletes something, the old
   * fallback made BACK perform the deletion. Every current call site happens to pair a
   * destructive action with an explicit cancel button, so this was a defect-in-waiting rather
   * than a live bug — the first single-action destructive dialog would have triggered it.
   * Back on such a dialog now just dismisses.
   */
  const onRequestClose = (): void => {
    const cancel = buttons.find((b) => b.style === 'cancel') ?? buttons[buttons.length - 1];
    dismiss();
    if (cancel?.style === 'destructive') return; // dismiss only — never delete on Back
    cancel?.onPress?.();
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onRequestClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.color.secondaryBackground }]}>
          <View style={styles.body}>
            <Text style={[styles.title, { color: theme.color.label }]}>{title}</Text>
            {message ? (
              <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>{message}</Text>
            ) : null}
          </View>
          <View
            style={[
              horizontal ? styles.rowButtons : styles.colButtons,
              { borderTopColor: theme.color.separator },
            ]}
          >
            {buttons.map((b, i) => {
              const color = b.style === 'destructive' ? theme.color.destructive : theme.color.tint;
              return (
                <React.Fragment key={i}>
                  {i > 0 ? (
                    <View
                      style={[
                        horizontal ? styles.vDivider : styles.hDivider,
                        { backgroundColor: theme.color.separator },
                      ]}
                    />
                  ) : null}
                  <Pressable
                    onPress={() => press(b)}
                    style={[styles.button, horizontal ? styles.buttonFlex : null]}
                    accessibilityRole="button"
                  >
                    <Text
                      style={[
                        styles.buttonText,
                        { color, fontWeight: b.style === 'cancel' ? '400' : '600' },
                      ]}
                    >
                      {b.text}
                    </Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 300, borderRadius: 14, overflow: 'hidden' },
  body: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 16, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  message: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  rowButtons: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  colButtons: { flexDirection: 'column', borderTopWidth: StyleSheet.hairlineWidth },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonFlex: { flex: 1 },
  buttonText: { fontSize: 17 },
  vDivider: { width: StyleSheet.hairlineWidth },
  hDivider: { height: StyleSheet.hairlineWidth },
});
