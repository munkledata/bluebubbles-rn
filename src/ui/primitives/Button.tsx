import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

type Variant = 'filled' | 'tinted' | 'plain';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  destructive?: boolean;
  style?: ViewStyle;
}

/** iOS-style button (filled / tinted / plain) using theme tint. */
export function Button({
  title,
  onPress,
  variant = 'filled',
  disabled = false,
  loading = false,
  destructive = false,
  style,
}: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const accent = destructive ? theme.color.destructive : theme.color.tint;
  const isDisabled = disabled || loading;

  const containerStyle: ViewStyle = {
    backgroundColor:
      variant === 'filled' ? accent : variant === 'tinted' ? `${accent}22` : 'transparent',
    opacity: isDisabled ? 0.5 : 1,
    borderRadius: theme.radius.card,
  };
  const textColor = variant === 'filled' ? '#FFFFFF' : accent;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        containerStyle,
        pressed && !isDisabled ? styles.pressed : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.label, { color: textColor, fontSize: theme.font.size.body }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  label: { fontWeight: '600' },
});
