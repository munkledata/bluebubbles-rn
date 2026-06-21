import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  createCustomTheme,
  deleteCustomTheme,
  listCustomThemes,
  updateCustomTheme,
  type CustomThemeRow,
} from '@db/repositories';
import { useThemeStore } from '@state/themeStore';
import { Screen, ThemeStudio, useTheme } from '@ui';
import { resolvePreset, safeParseTokens, type ThemeTokens } from '@ui/theme/tokens';

/** Which theme the studio is editing: a new one, or an existing row. */
type Editing = { row: CustomThemeRow | null };

/** F-12: create/edit/delete custom themes and pick the active one (live recolor). */
export default function ThemesScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const activeId = useThemeStore((s) => s.customThemeId);
  const setCustomTheme = useThemeStore((s) => s.setCustomTheme);
  const clearCustomTheme = useThemeStore((s) => s.clearCustomTheme);
  const reloadCustomTokens = useThemeStore((s) => s.reloadCustomTokens);
  const presetKey = useThemeStore((s) => s.preset);

  const [rows, setRows] = useState<CustomThemeRow[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await listCustomThemes(getDatabase()));
    } catch {
      // keep the current list on a transient read error
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tokens the studio opens with: the row's stored tokens, or the active preset for a new theme.
  const editorTokens = (): ThemeTokens => {
    const fromRow = editing?.row ? safeParseTokens(editing.row.tokens) : null;
    return fromRow ?? resolvePreset(presetKey);
  };

  const onApply = async (tokens: ThemeTokens, name: string): Promise<void> => {
    const blob = JSON.stringify(tokens);
    try {
      const db = getDatabase();
      if (editing?.row == null) {
        const id = await createCustomTheme(db, { name, mode: tokens.mode, tokens: blob });
        await setCustomTheme(id, tokens); // activate the new theme
      } else {
        const id = editing.row.id;
        await updateCustomTheme(db, id, { name, mode: tokens.mode, tokens: blob });
        if (id === activeId) await reloadCustomTokens(); // live recolor
      }
      setEditing(null);
      await refresh();
    } catch {
      Alert.alert('Theme', 'Couldn’t save the theme.');
    }
  };

  const onDelete = (row: CustomThemeRow): void => {
    Alert.alert('Delete theme', `Delete “${row.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteCustomTheme(getDatabase(), row.id);
              if (row.id === activeId) await clearCustomTheme(); // revert to preset
              await refresh();
            } catch {
              Alert.alert('Theme', 'Couldn’t delete the theme.');
            }
          })();
        },
      },
    ]);
  };

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>Custom Themes</Text>
        <Pressable onPress={() => setEditing({ row: null })} hitSlop={8}>
          <Text style={[styles.add, { color: theme.color.tint }]}>＋</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {rows.length === 0 ? (
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            No custom themes yet. Tap ＋ to create one from your current colors.
          </Text>
        ) : null}
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          {rows.map((row, i) => (
            <View
              key={row.id}
              style={[
                styles.row,
                i > 0 && {
                  borderTopColor: theme.color.separator,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Pressable
                style={styles.rowMain}
                onPress={() => {
                  const tokens = safeParseTokens(row.tokens);
                  if (!tokens) {
                    Alert.alert('Theme', 'This theme is corrupted and can’t be applied.');
                    return;
                  }
                  void setCustomTheme(row.id, tokens);
                }}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>{row.name}</Text>
                <Text style={[styles.rowSub, { color: theme.color.tertiaryLabel }]}>
                  {row.mode === 'dark' ? 'Dark' : 'Light'}
                  {row.id === activeId ? ' · Active' : ''}
                </Text>
              </Pressable>
              {row.id === activeId ? (
                <Text style={[styles.check, { color: theme.color.tint }]}>✓</Text>
              ) : null}
              <Pressable onPress={() => setEditing({ row })} hitSlop={8} style={styles.action}>
                <Text style={[styles.actionText, { color: theme.color.tint }]}>Edit</Text>
              </Pressable>
              <Pressable onPress={() => onDelete(row)} hitSlop={8} style={styles.action}>
                <Text style={[styles.actionText, { color: theme.color.destructive }]}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>

        {activeId != null ? (
          <Pressable onPress={() => void clearCustomTheme()} style={styles.revert}>
            <Text style={[styles.revertText, { color: theme.color.tint }]}>
              Revert to built-in preset
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {editing ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setEditing(null)}>
          <ThemeStudio
            title={editing.row == null ? 'New Theme' : 'Edit Theme'}
            initialTokens={editorTokens()}
            initialName={editing.row?.name ?? 'My Theme'}
            showName
            onApply={(tokens, name) => void onApply(tokens, name)}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17 },
  add: { fontSize: 26, fontWeight: '400' },
  title: { fontSize: 17, fontWeight: '600' },
  content: { paddingVertical: 12 },
  empty: { textAlign: 'center', marginTop: 40, marginHorizontal: 24, fontSize: 15, lineHeight: 21 },
  group: { marginHorizontal: 16, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  rowMain: { flex: 1 },
  rowLabel: { fontSize: 16 },
  rowSub: { fontSize: 12, marginTop: 2 },
  check: { fontSize: 17, fontWeight: '700' },
  action: { paddingHorizontal: 4 },
  actionText: { fontSize: 15 },
  revert: { alignItems: 'center', marginTop: 24 },
  revertText: { fontSize: 15 },
});
