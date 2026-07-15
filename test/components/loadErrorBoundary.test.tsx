/**
 * LoadErrorBoundary (src/ui/LoadErrorBoundary.tsx): a tiny local error boundary for lazily-loaded
 * native components. A failed React.lazy import (or any child throw) is contained to its own
 * subtree — it renders the fallback instead of propagating to the root boundary and blanking the
 * app, and calls onError once.
 *
 * Behaviours locked in:
 *   - happy path: children render;
 *   - a throwing child renders the provided fallback + fires onError exactly once;
 *   - with no fallback prop, a throwing child renders nothing (fallback ?? null).
 *
 * React logs the caught error via console.error; we silence it in the throwing tests.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen } from './support/renderWithTheme';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';

/** A child that throws during render (mimics a rejected React.lazy chunk). */
function Boom(): React.JSX.Element {
  throw new Error('chunk load failed');
}

describe('LoadErrorBoundary', () => {
  it('renders its children on the happy path', async () => {
    await renderWithTheme(
      <LoadErrorBoundary fallback={<Text>fallback</Text>}>
        <Text>loaded content</Text>
      </LoadErrorBoundary>,
    );

    expect(screen.getByText('loaded content')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('renders the fallback and calls onError when a child throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    try {
      await renderWithTheme(
        <LoadErrorBoundary fallback={<Text>graceful fallback</Text>} onError={onError}>
          <Boom />
        </LoadErrorBoundary>,
      );

      expect(screen.getByText('graceful fallback')).toBeTruthy();
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('renders nothing when a child throws and no fallback is given', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderWithTheme(
        <LoadErrorBoundary>
          <Boom />
          <Text>should not render</Text>
        </LoadErrorBoundary>,
      );

      // Failed state + no fallback → null; the child's content is gone.
      expect(screen.queryByText('should not render')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
