import React from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '../theme';

interface TextFieldProps extends TextInputProps {
  label?: string;
}

/** Labeled iOS-style text input bound to the theme. */
export function TextField({
  label,
  style,
  accessibilityLabel,
  accessibilityLabelledBy,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  ...inputProps
}: TextFieldProps): React.JSX.Element {
  const theme = useTheme();
  const generatedLabelId = React.useId();
  const visualLabelId = label ? `text-field-label-${generatedLabelId}` : undefined;
  const hasExplicitAccessibleName =
    accessibilityLabel != null ||
    accessibilityLabelledBy != null ||
    ariaLabel != null ||
    ariaLabelledBy != null;

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text
          nativeID={visualLabelId}
          style={[styles.label, { color: theme.color.secondaryLabel }]}
        >
          {label}
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel={accessibilityLabel}
        accessibilityLabelledBy={
          accessibilityLabelledBy ?? (hasExplicitAccessibleName ? undefined : visualLabelId)
        }
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        placeholderTextColor={theme.color.tertiaryLabel}
        style={[
          styles.input,
          {
            color: theme.color.label,
            backgroundColor: theme.color.secondaryBackground,
            borderRadius: theme.radius.card,
            fontSize: theme.font.size.body,
          },
          style,
        ]}
        {...inputProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: {
    fontSize: 13,
    marginBottom: 6,
    marginLeft: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: { minHeight: 50, paddingHorizontal: 14 },
});
