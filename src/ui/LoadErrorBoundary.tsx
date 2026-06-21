import React from 'react';

interface Props {
  /** Rendered when a child throws (incl. a `React.lazy` import REJECTION — Suspense only
   *  catches the *pending* promise, NOT a rejection, so without this a failed native-module
   *  chunk would propagate to the root ErrorBoundary and blank the whole app). */
  fallback?: React.ReactNode;
  /** Called once when an error is caught (e.g. to dismiss a modal). */
  onError?: () => void;
  children: React.ReactNode;
}

/**
 * Tiny local error boundary for lazily-loaded native components. Keeps a failed
 * `import()` (e.g. expo-audio not linked on a build) contained to its own subtree —
 * rendering a graceful fallback instead of crashing the app.
 */
export class LoadErrorBoundary extends React.Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError?.();
  }

  override render(): React.ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
