import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../primitives';
import { useTheme, withAlpha } from '../theme';

interface ChatSearchBarProps {
  value: string;
  onChangeText: (value: string) => void;
  status: string;
  loading: boolean;
  canGoOlder: boolean;
  canGoNewer: boolean;
  onGoOlder: () => void;
  onGoNewer: () => void;
  translucent?: boolean;
}

/**
 * Compact in-thread search controls. Query/navigation state stays in the chat screen so changing
 * chats or accounts destroys it with that screen instead of leaking a search into another thread.
 */
export function ChatSearchBar({
  value,
  onChangeText,
  status,
  loading,
  canGoOlder,
  canGoNewer,
  onGoOlder,
  onGoNewer,
  translucent = false,
}: ChatSearchBarProps): React.JSX.Element {
  const theme = useTheme();
  const background = translucent ? withAlpha(theme.color.background, 0.84) : theme.color.background;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: background, borderBottomColor: theme.color.separator },
      ]}
    >
      <View style={[styles.inputShell, { backgroundColor: theme.color.secondaryBackground }]}>
        <Icon name="search" size={18} color={theme.color.secondaryLabel} />
        <TextInput
          autoFocus
          value={value}
          onChangeText={onChangeText}
          placeholder="Search this conversation"
          placeholderTextColor={theme.color.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search messages in this conversation"
          style={[styles.input, { color: theme.color.label }]}
        />
        {value.length > 0 ? (
          <Pressable
            onPress={() => onChangeText('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear conversation search"
            style={styles.clearButton}
          >
            <Icon name="close-circle" size={19} color={theme.color.tertiaryLabel} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.resultRow}>
        <View style={styles.statusWrap}>
          {loading ? <ActivityIndicator size="small" color={theme.color.tint} /> : null}
          <Text
            numberOfLines={2}
            accessibilityLiveRegion="polite"
            style={[styles.status, { color: theme.color.secondaryLabel }]}
          >
            {status}
          </Text>
        </View>
        <View style={styles.navigation}>
          <Pressable
            onPress={onGoOlder}
            disabled={!canGoOlder}
            accessibilityRole="button"
            accessibilityLabel="Older search result"
            accessibilityState={{ disabled: !canGoOlder }}
            style={[styles.navButton, !canGoOlder && styles.disabled]}
          >
            <Icon name="chevron-up" size={20} color={theme.color.tint} />
          </Pressable>
          <Pressable
            onPress={onGoNewer}
            disabled={!canGoNewer}
            accessibilityRole="button"
            accessibilityLabel="Newer search result"
            accessibilityState={{ disabled: !canGoNewer }}
            style={[styles.navButton, !canGoNewer && styles.disabled]}
          >
            <Icon name="chevron-down" size={20} color={theme.color.tint} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inputShell: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: 12,
  },
  input: { flex: 1, minWidth: 0, paddingVertical: 8, fontSize: 16 },
  clearButton: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  statusWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { flex: 1, fontSize: 13, fontVariant: ['tabular-nums'] },
  navigation: { flexDirection: 'row', gap: 4 },
  navButton: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.35 },
});
