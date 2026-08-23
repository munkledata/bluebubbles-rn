import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import {
  createCustomThemeWithinTransaction,
  deleteCustomThemeWithinTransaction,
  getCustomThemeById,
  kvGet,
  kvSetWithinTransaction,
  listCustomThemes,
  THEME_CUSTOM_KEY,
  updateCustomThemeWithinTransaction,
  type CustomThemeRow,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useThemeStore } from '@state/themeStore';
import { Screen, ScreenHeader, ThemeStudio, useTheme } from '@ui';
import {
  darkThemeOrFallback,
  isDarkThemeTokens,
  resolvePreset,
  safeParseTokens,
  type ThemeTokens,
} from '@ui/theme/tokens';

/** Which theme the studio is editing: a new one, or an existing row. */
type Editing = { row: CustomThemeRow | null };

type AccountTaskResult<T> = { owned: true; value: T } | { owned: false };

/**
 * Attach a Themes-screen read/write to the account that mounted the screen.
 *
 * A dialog or Modal callback can run much later than the tap that created it. The captured lease
 * makes that old callback a quiet no-op after Disconnect, while the tracked slot makes Disconnect
 * wait for a short DB operation that was already admitted. Callers still use a DB commit guard for
 * writes so a lease revoked while SQLite is awaiting a statement rolls the transaction back.
 */
async function runThemesAccountTask<T>(
  lease: RealtimeDeliveryLease,
  task: (activeLease: RealtimeDeliveryLease) => Promise<T>,
): Promise<AccountTaskResult<T>> {
  let value: T | undefined;
  let completed = false;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent()) return;
      value = await task(activeLease);
      if (!activeLease.isCurrent()) return;
      completed = true;
    });
    if (status === 'paused' || !completed || !lease.isCurrent()) return { owned: false };
    return { owned: true, value: value as T };
  } catch (error) {
    // A commit-guard rejection is expected when Disconnect wins the race. Never surface that old
    // screen's error as a dialog (or ThemeStudio save error) in the replacement account.
    if (!lease.isCurrent()) return { owned: false };
    throw error;
  }
}

/** F-12: create/edit/delete custom themes and pick the active one (live recolor). */
export default function ThemesScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const activeId = useThemeStore((s) => s.customThemeId);
  const presetKey = useThemeStore((s) => s.preset);
  // This lease belongs to this mounted screen, not to whichever account happens to be connected
  // when a retained dialog/Modal callback eventually runs.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());

  const [rows, setRows] = useState<CustomThemeRow[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);

  // A mounted route can render once more while Disconnect replaces the account tree. Never let
  // already-resolved rows, the active marker, or an open editor from account A appear in that
  // handoff render for account B.
  const accountCurrent = accountLease.isCurrent();
  const visibleRows = accountCurrent ? rows : [];
  const visibleActiveId = accountCurrent ? activeId : null;

  const refresh = useCallback(async () => {
    try {
      const result = await runThemesAccountTask(accountLease, () =>
        listCustomThemes(getDatabase()),
      );
      if (result.owned) setRows(result.value);
    } catch {
      // keep the current list on a transient read error
    }
  }, [accountLease]);

  useEffect(() => {
    let mounted = true;
    void runThemesAccountTask(accountLease, () => listCustomThemes(getDatabase()))
      .then((result) => {
        if (mounted && result.owned) setRows(result.value);
      })
      .catch(() => {
        // Keep the empty initial list on a transient read error.
      });
    return () => {
      mounted = false;
    };
  }, [accountLease]);

  // Tokens the studio opens with: the row's stored tokens, or the active preset for a new theme.
  const editorTokens = (): ThemeTokens => {
    const fromRow = editing?.row ? safeParseTokens(editing.row.tokens) : null;
    return darkThemeOrFallback(fromRow, resolvePreset(presetKey));
  };

  const onApply = async (tokens: ThemeTokens, name: string): Promise<void> => {
    if (!isDarkThemeTokens(tokens)) {
      throw new Error('Light themes are unavailable while Gator is dark-only.');
    }
    const blob = JSON.stringify(tokens);
    // NOTE: no try/catch here — a failed save must REJECT so ThemeStudio shows the error inline
    // (the editor is in a Modal, where a stacked dialog is unreliable on Android) and keeps the
    // editor open with the user's edits. On success setEditing(null) closes it; refresh is
    // fire-and-forget (the theme is already saved, a refresh hiccup must not report a false error).
    const editingRow = editing?.row ?? null;
    const result = await runThemesAccountTask(accountLease, async (lease) => {
      const db = getDatabase();
      if (editingRow == null) {
        const id = await withDbTransaction(
          db,
          async (context) => {
            const createdId = await createCustomThemeWithinTransaction(context, {
              name,
              mode: tokens.mode,
              tokens: blob,
            });
            // Creating a theme also activates it. Keep the row + pointer in ONE guarded commit so
            // neither a failed write nor an account transition can leave a dangling selection.
            await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, String(createdId));
            return createdId;
          },
          () => lease.isCurrent(),
        );
        return { id, activate: true };
      }

      const id = editingRow.id;
      await withDbTransaction(
        db,
        (context) =>
          updateCustomThemeWithinTransaction(context, id, {
            name,
            mode: tokens.mode,
            tokens: blob,
          }),
        () => lease.isCurrent(),
      );
      return { id, activate: useThemeStore.getState().customThemeId === id };
    });
    if (!result.owned) return;

    // Zustand's state write is synchronous. The account check in runThemesAccountTask and this
    // assignment therefore cannot be interleaved by Disconnect.
    if (result.value.activate) {
      useThemeStore.setState({
        customThemeId: result.value.id,
        customTokens: tokens,
      });
    }
    setEditing(null);
    void refresh();
  };

  const onDelete = (row: CustomThemeRow): void => {
    if (!accountLease.isCurrent()) return;
    showDialog('Delete theme', `Delete “${row.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const result = await runThemesAccountTask(accountLease, async (lease) => {
              const db = getDatabase();
              await withDbTransaction(
                db,
                async (context) => {
                  // The persisted pointer, not a Zustand snapshot, decides what this DB commit
                  // clears. Memory can legitimately move to a newer selection while a retained
                  // confirmation waits for the mutex.
                  const persistedActiveId = await kvGet(db, THEME_CUSTOM_KEY);
                  await deleteCustomThemeWithinTransaction(context, row.id);
                  if (persistedActiveId === String(row.id)) {
                    await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, '');
                  }
                },
                () => lease.isCurrent(),
              );
            });
            if (!result.owned) return;
            // Re-check memory independently after commit: preserve a newer in-memory choice,
            // but retire the deleted row if memory still points at it even when DB already moved.
            if (useThemeStore.getState().customThemeId === row.id) {
              useThemeStore.setState({ customThemeId: null, customTokens: null });
            }
            await refresh();
          } catch {
            if (accountLease.isCurrent()) {
              showDialog('Theme', 'Couldn’t delete the theme.');
            }
          }
        },
      },
    ]);
  };

  const onSelect = (row: CustomThemeRow): void => {
    void (async () => {
      try {
        const result = await runThemesAccountTask(accountLease, async (lease) => {
          const db = getDatabase();
          return withDbTransaction(
            db,
            async (context) => {
              // Re-read under the same guarded commit instead of trusting a row retained by an
              // old render. It may have been edited/deleted while this callback was queued.
              const currentRow = await getCustomThemeById(db, row.id);
              const currentTokens = currentRow ? safeParseTokens(currentRow.tokens) : null;
              if (!isDarkThemeTokens(currentTokens)) {
                throw new Error('Theme is missing, corrupt, or unavailable.');
              }
              await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, String(row.id));
              return currentTokens;
            },
            () => lease.isCurrent(),
          );
        });
        if (!result.owned) return;
        useThemeStore.setState({ customThemeId: row.id, customTokens: result.value });
      } catch {
        if (accountLease.isCurrent()) {
          showDialog('Theme', 'Couldn’t apply the theme.');
        }
      }
    })();
  };

  const onRevert = (): void => {
    void (async () => {
      try {
        const result = await runThemesAccountTask(accountLease, async (lease) => {
          const db = getDatabase();
          await withDbTransaction(
            db,
            (context) => kvSetWithinTransaction(context, THEME_CUSTOM_KEY, ''),
            () => lease.isCurrent(),
          );
        });
        if (!result.owned) return;
        useThemeStore.setState({ customThemeId: null, customTokens: null });
      } catch {
        if (accountLease.isCurrent()) {
          showDialog('Theme', 'Couldn’t revert to the built-in preset.');
        }
      }
    })();
  };

  return (
    <Screen>
      <ScreenHeader
        title="Custom Themes"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() => {
              if (accountLease.isCurrent()) setEditing({ row: null });
            }}
            hitSlop={8}
          >
            <Text style={[styles.add, { color: theme.color.tint }]}>＋</Text>
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={styles.content}>
        {visibleRows.length === 0 ? (
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            No custom themes yet. Tap ＋ to create one from your current colors.
          </Text>
        ) : null}
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          {visibleRows.map((row, i) => {
            const storedTokens = safeParseTokens(row.tokens);
            const available = isDarkThemeTokens(storedTokens);
            return (
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
                    if (!accountLease.isCurrent()) return;
                    if (!storedTokens) {
                      showDialog('Theme', 'This theme is corrupted and can’t be applied.');
                      return;
                    }
                    if (!available) {
                      showDialog(
                        'Light theme unavailable',
                        'This saved light theme can’t be applied while Gator is dark-only. You can edit and save it as a dark theme.',
                      );
                      return;
                    }
                    onSelect(row);
                  }}
                >
                  <Text style={[styles.rowLabel, { color: theme.color.label }]}>{row.name}</Text>
                  <Text style={[styles.rowSub, { color: theme.color.tertiaryLabel }]}>
                    {available ? 'Dark' : storedTokens ? 'Light · Unavailable' : 'Unavailable'}
                    {row.id === visibleActiveId ? ' · Active' : ''}
                  </Text>
                </Pressable>
                {row.id === visibleActiveId ? (
                  <Text style={[styles.check, { color: theme.color.tint }]}>✓</Text>
                ) : null}
                <Pressable
                  onPress={() => {
                    if (accountLease.isCurrent()) setEditing({ row });
                  }}
                  hitSlop={8}
                  style={styles.action}
                >
                  <Text style={[styles.actionText, { color: theme.color.tint }]}>Edit</Text>
                </Pressable>
                <Pressable onPress={() => onDelete(row)} hitSlop={8} style={styles.action}>
                  <Text style={[styles.actionText, { color: theme.color.destructive }]}>
                    Delete
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>

        {visibleActiveId != null ? (
          <Pressable onPress={onRevert} style={styles.revert}>
            <Text style={[styles.revertText, { color: theme.color.tint }]}>
              Revert to built-in preset
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {accountCurrent && editing ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setEditing(null)}>
          <ThemeStudio
            title={editing.row == null ? 'New Theme' : 'Edit Theme'}
            initialTokens={editorTokens()}
            initialName={editing.row?.name ?? 'My Theme'}
            showName
            onApply={onApply}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: { fontSize: 26, fontWeight: '400', textAlign: 'right' },
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
