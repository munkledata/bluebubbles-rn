import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}
interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level error boundary so a render throw shows a recoverable fallback instead
 * of a white screen. Mounted ABOVE the ThemeProvider (so it also catches theme
 * errors), hence the neutral dark palette rather than theme tokens. "Try Again"
 * clears the error and re-renders; messages are safe in the encrypted DB.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Redacted central logger (the Sentry breadcrumb seam — see RELEASE_CHECKLIST §9.2).
    logger.error('[ErrorBoundary] render crash', { error, componentStack: info.componentStack });
  }

  private reset = (): void => this.setState({ error: null });

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Text style={styles.emoji}>🫧</Text>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The app hit an unexpected error. Try again — your messages are saved.
        </Text>
        <Pressable
          onPress={this.reset}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={styles.buttonText}>Try Again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emoji: { fontSize: 56, marginBottom: 16 },
  title: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  body: { color: '#A0A0A0', fontSize: 15, textAlign: 'center', lineHeight: 21, marginBottom: 28 },
  button: {
    backgroundColor: '#1982FC',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
  },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
