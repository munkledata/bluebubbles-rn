import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { Screen, useTheme } from '@ui';
import { cloneTokens, EDITABLE_COLORS, isValidHex } from '@ui/theme/editableTokens';
import { resolvePreset, type ThemeMode, type ThemeTokens } from '@ui/theme/tokens';

interface Draft {
  id: number | null;
  name: string;
  mode: ThemeMode;
  base: ThemeTokens;
  hex: Record<string, string>;
}

function draftFrom(row: CustomThemeRow | null, fallback: ThemeTokens): Draft {
  let base = fallback;
  if (row) {
    try {
      base = JSON.parse(row.tokens) as ThemeTokens;
    } catch {
      base = fallback;
    }
  }
  return {
    id: row?.id ?? null,
    name: row?.name ?? 'My Theme',
    mode: base.mode,
    base: cloneTokens(base),
    hex: Object.fromEntries(EDITABLE_COLORS.map((f) => [f.key, f.read(base)])),
  };
}

/** Build the full token set from a draft's edited hex values (assumes all valid). */
function tokensFromDraft(d: Draft): ThemeTokens {
  const out = cloneTokens(d.base);
  out.mode = d.mode;
  for (const f of EDITABLE_COLORS) f.write(out, (d.hex[f.key] ?? '').trim());
  return out;
}

/** Safe parse of a stored tokens blob (a corrupt row must not crash the screen). */
function safeParseTokens(json: string): ThemeTokens | null {
  try {
    return JSON.parse(json) as ThemeTokens;
  } catch {
    return null;
  }
}

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
  const [draft, setDraft] = useState<Draft | null>(null);

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

  const openNew = (): void => setDraft(draftFrom(null, resolvePreset(presetKey)));
  const openEdit = (row: CustomThemeRow): void =>
    setDraft(draftFrom(row, resolvePreset(presetKey)));

  const onSave = async (): Promise<void> => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      Alert.alert('Theme', 'Give your theme a name.');
      return;
    }
    const bad = EDITABLE_COLORS.find((f) => !isValidHex(draft.hex[f.key] ?? ''));
    if (bad) {
      Alert.alert('Theme', `“${bad.label}” needs a valid hex color (e.g. #1982FC).`);
      return;
    }
    const tokens = JSON.stringify(tokensFromDraft(draft));
    try {
      const db = getDatabase();
      if (draft.id == null) {
        const id = await createCustomTheme(db, { name, mode: draft.mode, tokens });
        await setCustomTheme(id, tokensFromDraft(draft)); // activate the new theme
      } else {
        await updateCustomTheme(db, draft.id, { name, mode: draft.mode, tokens });
        if (draft.id === activeId) await reloadCustomTokens(); // live recolor
      }
      setDraft(null);
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
        <Pressable onPress={openNew} hitSlop={8}>
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
              <Pressable onPress={() => openEdit(row)} hitSlop={8} style={styles.action}>
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

      {draft ? (
        <ThemeEditorModal
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void onSave()}
        />
      ) : null}
    </Screen>
  );
}

function ThemeEditorModal({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={[styles.sheet, { backgroundColor: theme.color.background }]}>
        <View style={[styles.sheetHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onCancel} hitSlop={8}>
            <Text style={[styles.back, { color: theme.color.tint }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.color.label }]}>
            {draft.id == null ? 'New Theme' : 'Edit Theme'}
          </Text>
          <Pressable onPress={onSave} hitSlop={8}>
            <Text style={[styles.save, { color: theme.color.tint }]}>Save</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.editorContent}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            value={draft.name}
            onChangeText={(name) => onChange({ ...draft, name })}
            placeholder="Theme name"
            placeholderTextColor={theme.color.tertiaryLabel}
            style={[
              styles.nameInput,
              {
                color: theme.color.label,
                backgroundColor: theme.color.secondaryBackground,
                borderColor: theme.color.separator,
              },
            ]}
          />
          <View style={styles.modeRow}>
            {(['light', 'dark'] as const).map((m) => (
              <Pressable
                key={m}
                onPress={() => onChange({ ...draft, mode: m })}
                style={[
                  styles.modeBtn,
                  {
                    backgroundColor:
                      draft.mode === m ? theme.color.tint : theme.color.secondaryBackground,
                  },
                ]}
              >
                <Text
                  style={{
                    color: draft.mode === m ? '#fff' : theme.color.label,
                    fontWeight: '600',
                  }}
                >
                  {m === 'light' ? 'Light' : 'Dark'}
                </Text>
              </Pressable>
            ))}
          </View>

          {EDITABLE_COLORS.map((f) => {
            const val = draft.hex[f.key] ?? '';
            const ok = isValidHex(val);
            return (
              <View key={f.key} style={styles.colorRow}>
                <Text style={[styles.colorLabel, { color: theme.color.label }]}>{f.label}</Text>
                <View
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: ok ? val.trim() : 'transparent',
                      borderColor: theme.color.separator,
                    },
                  ]}
                />
                <TextInput
                  value={val}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(v) => onChange({ ...draft, hex: { ...draft.hex, [f.key]: v } })}
                  placeholder="#RRGGBB"
                  placeholderTextColor={theme.color.tertiaryLabel}
                  style={[
                    styles.hexInput,
                    {
                      color: ok ? theme.color.label : theme.color.destructive,
                      backgroundColor: theme.color.secondaryBackground,
                      borderColor: ok ? theme.color.separator : theme.color.destructive,
                    },
                  ]}
                />
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
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
  save: { fontSize: 17, fontWeight: '600' },
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
  // editor
  sheet: { flex: 1 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  editorContent: { padding: 16, paddingBottom: 60 },
  nameInput: {
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 14,
  },
  modeRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  modeBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  colorLabel: { flex: 1, fontSize: 14 },
  swatch: { width: 28, height: 28, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  hexInput: {
    width: 120,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontVariant: ['tabular-nums'],
  },
});
