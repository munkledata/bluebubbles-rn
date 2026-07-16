import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ContactPick } from '@db/repositories';
import { useTheme } from './theme';

/**
 * Tappable contact-suggestion rows under a recipient input (new-chat, FaceTime dialer).
 * Renders nothing when there are no suggestions.
 */
export function ContactSuggestionList({
  suggestions,
  onPick,
}: {
  suggestions: ContactPick[];
  onPick: (pick: ContactPick) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (suggestions.length === 0) return null;
  return (
    <View style={styles.suggestions}>
      {suggestions.map((c, i) => (
        <Pressable
          key={`${c.address}-${i}`}
          onPress={() => onPick(c)}
          style={[styles.suggestion, { borderBottomColor: theme.color.separator }]}
        >
          <Text style={[styles.suggestionName, { color: theme.color.label }]}>
            {c.name || c.address}
          </Text>
          {c.name ? (
            <Text style={[styles.suggestionAddr, { color: theme.color.secondaryLabel }]}>
              {c.address}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  suggestions: { borderRadius: 12, overflow: 'hidden' },
  suggestion: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  suggestionName: { fontSize: 16 },
  suggestionAddr: { fontSize: 13, marginTop: 2 },
});
