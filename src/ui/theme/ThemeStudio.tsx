import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../primitives/Button';
import {
  auditThemeContrast,
  cloneTokens,
  EDITABLE_COLORS,
  fixThemeContrast,
  isValidHex,
} from './editableTokens';
import { ThemePreviewCard } from './ThemePreviewCard';
import { useTheme } from './ThemeProvider';
import { darkThemeOrFallback, type ThemeTokens } from './tokens';

// ---- Draft model (shared by the global manager + the per-chat studio) -------

/** A theme being edited: a base token set + the user's edited hex strings. */
export interface Draft {
  name: string;
  base: ThemeTokens;
  hex: Record<string, string>;
}

/** Seed a draft from a starting token set (and optional name). */
export function draftFrom(base: ThemeTokens, name: string): Draft {
  // Do not merely relabel a legacy light palette as dark. Start it from the active dark
  // fallback, so saving is an explicit conversion to readable dark colors.
  const darkBase = darkThemeOrFallback(base);
  return {
    name,
    base: cloneTokens(darkBase),
    hex: Object.fromEntries(EDITABLE_COLORS.map((f) => [f.key, f.read(darkBase)])),
  };
}

/** Build the full token set from a draft's edited hex values (assumes all valid). */
export function tokensFromDraft(d: Draft): ThemeTokens {
  const out = cloneTokens(d.base);
  out.mode = 'dark';
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
 * Reusable dark-theme editor: a live preview, a name field (optional), and the 13
 * EDITABLE_COLORS hex inputs + swatches with validation. The
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
  const seed = darkThemeOrFallback(initialTokens, theme);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(seed, initialName ?? 'My Theme'));
  // Inline validation / save error. Shown in the editor itself — NOT a dialog: this editor is
  // rendered inside a Modal, and Android reliably shows only one Modal at a time, so a stacked
  // dialog would not display (a themed-dialog-over-Modal regression).
  const [error, setError] = useState<string | null>(null);
  const [contrastConfirmation, setContrastConfirmation] = useState(false);

  // Live preview/audit tokens are built only when every hex is valid. An in-progress invalid edit
  // keeps the safe base preview and cannot enter the contrast math.
  const validDraftTokens = useMemo<ThemeTokens | null>(() => {
    const allValid = EDITABLE_COLORS.every((f) => isValidHex(draft.hex[f.key] ?? ''));
    return allValid ? tokensFromDraft(draft) : null;
  }, [draft]);
  const previewTokens = validDraftTokens ?? draft.base;
  const contrastIssues = useMemo(
    () => (validDraftTokens ? auditThemeContrast(validDraftTokens) : []),
    [validDraftTokens],
  );
  const contrastIssueKeys = useMemo(
    () => new Set(contrastIssues.map((issue) => issue.foregroundKey)),
    [contrastIssues],
  );

  const updateDraft = (next: Draft): void => {
    setDraft(next);
    setContrastConfirmation(false);
    setError(null);
  };

  const autoFixContrast = (): void => {
    if (!validDraftTokens || contrastIssues.length === 0) return;
    const fixed = fixThemeContrast(validDraftTokens, contrastIssues);
    updateDraft({
      ...draft,
      hex: Object.fromEntries(EDITABLE_COLORS.map((field) => [field.key, field.read(fixed)])),
    });
  };

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
    const tokens = tokensFromDraft(draft);
    const issues = auditThemeContrast(tokens);
    if (issues.length > 0 && !contrastConfirmation) {
      setContrastConfirmation(true);
      setError(null);
      return;
    }
    setError(null);
    try {
      // Await so a failing save (onApply rejects) surfaces inline instead of leaving the editor
      // looking like Apply did nothing. onApply keeps the editor open on failure (edits preserved).
      await onApply(tokens, name);
    } catch {
      setError('Couldn’t save the theme. Try again.');
    }
  };

  return (
    <View style={[styles.sheet, { backgroundColor: theme.color.background }]}>
      <View style={[styles.sheetHeader, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={onCancel}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Cancel theme changes"
        >
          <Text style={[styles.back, { color: theme.color.tint }]}>Cancel</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>{title}</Text>
        <Pressable
          onPress={() => void apply()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={contrastConfirmation ? 'Apply unreadable theme anyway' : 'Apply'}
        >
          <Text style={[styles.save, { color: theme.color.tint }]}>
            {contrastConfirmation ? 'Apply anyway' : 'Apply'}
          </Text>
        </Pressable>
      </View>
      {error ? (
        <View style={[styles.errorBar, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.errorText, { color: theme.color.destructive }]}>{error}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemePreviewCard tokens={previewTokens} />

        {contrastIssues.length > 0 ? (
          <View
            style={[
              styles.contrastWarning,
              {
                backgroundColor: theme.color.secondaryBackground,
                borderColor: theme.color.destructive,
              },
            ]}
          >
            <Text style={[styles.contrastTitle, { color: theme.color.label }]}>Low contrast</Text>
            <Text style={[styles.contrastSummary, { color: theme.color.secondaryLabel }]}>
              {contrastConfirmation
                ? 'These colors can be hard to read. Fix them, or choose Apply anyway to confirm.'
                : 'These text roles are below the 4.5:1 readability target.'}
            </Text>
            {contrastIssues.map((issue) => (
              <View
                key={issue.id}
                style={styles.contrastRole}
                accessible
                accessibilityLabel={`${issue.label}: ${issue.ratio.toFixed(2)} to 1 on ${issue.backgroundLabel}; needs ${issue.requiredRatio.toFixed(1)} to 1`}
              >
                <View
                  style={[
                    styles.contrastSample,
                    { backgroundColor: issue.background, borderColor: theme.color.separator },
                  ]}
                >
                  <Text style={[styles.contrastSampleText, { color: issue.foreground }]}>Aa</Text>
                </View>
                <View style={styles.contrastCopy}>
                  <Text style={[styles.contrastRoleLabel, { color: theme.color.label }]}>
                    {issue.label}
                  </Text>
                  <Text style={[styles.contrastRatio, { color: theme.color.secondaryLabel }]}>
                    {issue.ratio.toFixed(2)}:1 on {issue.backgroundLabel}; needs{' '}
                    {issue.requiredRatio.toFixed(1)}:1
                  </Text>
                </View>
              </View>
            ))}
            <Button
              title="Auto-fix text colors"
              variant="tinted"
              onPress={autoFixContrast}
              style={styles.contrastButton}
              accessibilityHint="Replaces failing text colors with readable light or dark colors"
            />
          </View>
        ) : null}

        {showName ? (
          <TextInput
            value={draft.name}
            onChangeText={(name) => updateDraft({ ...draft, name })}
            accessibilityLabel="Theme name"
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

        {EDITABLE_COLORS.map((f) => {
          const val = draft.hex[f.key] ?? '';
          const ok = isValidHex(val);
          const contrastIssue = contrastIssueKeys.has(f.key);
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
                accessibilityLabel={f.label}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(v) => updateDraft({ ...draft, hex: { ...draft.hex, [f.key]: v } })}
                placeholder="#RRGGBB"
                placeholderTextColor={theme.color.tertiaryLabel}
                style={[
                  styles.hexInput,
                  {
                    color: ok && !contrastIssue ? theme.color.label : theme.color.destructive,
                    backgroundColor: theme.color.secondaryBackground,
                    borderColor:
                      ok && !contrastIssue ? theme.color.separator : theme.color.destructive,
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
  contrastWarning: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    gap: 8,
  },
  contrastTitle: { fontSize: 16, fontWeight: '600' },
  contrastSummary: { fontSize: 14, lineHeight: 19 },
  contrastRole: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  contrastSample: {
    width: 44,
    height: 36,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contrastSampleText: { fontSize: 15, fontWeight: '600' },
  contrastCopy: { flex: 1 },
  contrastRoleLabel: { fontSize: 14, fontWeight: '600' },
  contrastRatio: { fontSize: 12, lineHeight: 17 },
  contrastButton: { marginTop: 2 },
  nameInput: {
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    marginBottom: 14,
  },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
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
