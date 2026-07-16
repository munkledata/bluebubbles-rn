import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

interface SettingsSectionProps {
  /** Uppercase iOS-style heading above the group; omit for a bare group. */
  label?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * iOS grouped-settings section: optional heading + rounded group that draws a hairline
 * divider between rows (never before the first). Conditional `null` children are skipped,
 * so `{cond ? <Row … /> : null}` never leaves a stray divider. Rows are typically the
 * `SettingsRow` family, but any element works.
 */
export function SettingsSection({
  label,
  children,
  style,
}: SettingsSectionProps): React.JSX.Element {
  const theme = useTheme();
  const rows = React.Children.toArray(children);
  return (
    <View style={style}>
      {label != null ? (
        <Text style={[styles.label, { color: theme.color.secondaryLabel }]}>{label}</Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
        {rows.map((row, i) => (
          <React.Fragment key={React.isValidElement(row) && row.key != null ? row.key : i}>
            {i > 0 ? (
              <View
                testID="settings-divider"
                style={[styles.divider, { backgroundColor: theme.color.separator }]}
              />
            ) : null}
            {row}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, marginBottom: 6, marginLeft: 12 },
  group: { borderRadius: 12, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth },
});
