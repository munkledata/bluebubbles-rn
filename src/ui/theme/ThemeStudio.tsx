import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cloneTokens, EDITABLE_COLORS, isValidHex } from './editableTokens';
import { ThemePreviewCard } from './ThemePreviewCard';
import { useTheme } from './ThemeProvider';
import type { ThemeMode, ThemeTokens } from './tokens';

// ---- Draft model (shared by the global manager + the per-chat studio) -------

/** A theme being edited: a base token set + the user's edited hex strings. */
export interface Draft {
  name: string;
  mode: ThemeMode;
  base: ThemeTokens;
  hex: Record<string, string>;
}

/** Seed a draft from a starting token set (and optional name). */
export function draftFrom(base: ThemeTokens, name: string): Draft {
  return {
    name,
    mode: base.mode,
    base: cloneTokens(base),
    hex: Object.fromEntries(EDITABLE_COLORS.map((f) => [f.key, f.read(base)])),
  };
}

/** Build the full token set from a draft's edited hex values (assumes all valid). */
export function tokensFromDraft(d: Draft): ThemeTokens {
  const out = cloneTokens(d.base);
  out.mode = d.mode;
  for (const f of EDITABLE_COLORS) f.write(out, (d.hex[f.key] ?? '').trim());
  return out;
}

// ---- The reusable editor ----------------------------------------------------

export interface ThemeStudioProps {
  /** Starting tokens to edit (defaults to the active global theme via `useTheme()`). */
  initialTokens?: ThemeTokens;
  /** Starting name (only used when `showName`). */
  initialName?: string;
  /** Header title. */
  title?: string;
  /** Show the name field (global themes need a name; a per-chat theme doesn't). */
  showName?: boolean;
  /** Fires with the built tokens + trimmed name on Apply. May be async; a rejection surfaces as
   *  an inline error inside the editor (it's rendered in a Modal, so a stacked dialog is unreliable). */
  onApply: (tokens: ThemeTokens, name: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable theme editor: a live preview, a name field (optional), a light/dark mode
 * toggle, and the 13 EDITABLE_COLORS hex inputs + swatches with validation. The
 * global theme manager and the per-chat Chat Theme entry both render this — the only
 * difference is what `onApply` does with the result.
 */
export function ThemeStudio({
  initialTokens,
  initialName,
  title = 'Theme',
  showName = true,
  onApply,
  onCancel,
}: ThemeStudioProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Fall back to the active global theme as a starting point when no tokens are passed.
  const seed = initialTokens ?? theme;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(seed, initialName ?? 'My Theme'));
  // Inline validation / save error. Shown in the editor itself — NOT a dialog: this editor is
  // rendered inside a Modal, and Android reliably shows only one Modal at a time, so a stacked
  // dialog would not display (a themed-dialog-over-Modal regression).
  const [error, setError] = useState<string | null>(null);

  // Live preview tokens: built from the draft, but only when every hex is valid;
  // an in-progress (invalid) edit keeps the last good preview rather than crashing.
  const previewTokens = useMemo<ThemeTokens>(() => {
    const allValid = EDITABLE_COLORS.every((f) => isValidHex(draft.hex[f.key] ?? ''));
    return allValid ? tokensFromDraft(draft) : draft.base;
  }, [draft]);

  const apply = async (): Promise<void> => {
    const name = draft.name.trim();
    if (showName && !name) {
      setError('Give your theme a name.');
      return;
    }
    const bad = EDITABLE_COLORS.find((f) => !isValidHex(draft.hex[f.key] ?? ''));
    if (bad) {
      setError(`“${bad.label}” needs a valid hex color (e.g. #1982FC).`);
      return;
    }
    setError(null);
    try {
      // Await so a failing save (onApply rejects) surfaces inline instead of leaving the editor
      // looking like Apply did nothing. onApply keeps the editor open on failure (edits preserved).
      await onApply(tokensFromDraft(draft), name);
    } catch {
      setError('Couldn’t save the theme. Try again.');
    }
  };

  return (
    <View style={[styles.sheet, { backgroundColor: theme.color.background }]}>
      <View style={[styles.sheetHeader, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onCancel} hitSlop={8}>
          <Text style={[styles.back, { color: theme.color.tint }]}>Cancel</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>{title}</Text>
        <Pressable onPress={() => void apply()} hitSlop={8}>
          <Text style={[styles.save, { color: theme.color.tint }]}>Apply</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={[styles.errorBar, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.errorText, { color: theme.color.destructive }]}>{error}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemePreviewCard tokens={previewTokens} />

        {showName ? (
          <TextInput
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
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
        ) : null}

        <View style={styles.modeRow}>
          {(['light', 'dark'] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setDraft({ ...draft, mode: m })}
              style={[
                styles.modeBtn,
                {
                  backgroundColor:
                    draft.mode === m ? theme.color.tint : theme.color.secondaryBackground,
                },
              ]}
            >
              <Text
                style={{ color: draft.mode === m ? '#fff' : theme.color.label, fontWeight: '600' }}
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
                onChangeText={(v) => setDraft({ ...draft, hex: { ...draft.hex, [f.key]: v } })}
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
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  back: { fontSize: 17 },
  save: { fontSize: 17, fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '600' },
  errorBar: { paddingHorizontal: 16, paddingVertical: 8 },
  errorText: { fontSize: 13 },
  content: { padding: 16, paddingBottom: 60, gap: 0 },
  nameInput: {
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    marginBottom: 14,
  },
  modeRow: { flexDirection: 'row', gap: 10, marginTop: 16, marginBottom: 18 },
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
