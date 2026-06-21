import React, { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

interface ScreenProps {
  children?: ReactNode;
  /** Use the grouped (settings-style) background instead of the plain one. */
  grouped?: boolean;
  style?: ViewStyle;
}

/** Full-bleed themed screen container. Safe-area insets are added in the screen layer. */
export function Screen({ children, grouped = false, style }: ScreenProps): React.JSX.Element {
  const theme = useTheme();
  const backgroundColor = grouped ? theme.color.groupedBackground : theme.color.background;
  return <View style={[styles.root, { backgroundColor }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
