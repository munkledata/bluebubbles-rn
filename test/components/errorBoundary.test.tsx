/**
 * ErrorBoundary (src/ui/ErrorBoundary.tsx): the top-level catch that turns a render throw into a
 * recoverable fallback instead of a white screen. It's mounted ABOVE the ThemeProvider and uses
 * LITERAL colours (no theme tokens) precisely so it can survive a ThemeProvider throw — so it is
 * rendered here WITHOUT renderWithTheme (that's the point of these tests). React logs every caught
 * error to console.error; we silence that noise for the duration of each test.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ErrorBoundary } from '@ui/ErrorBoundary';

/** A child that throws until `shouldThrow` is flipped — lets us test recovery via "Try Again". */
function Boom({ shouldThrow }: { shouldThrow: () => boolean }): React.JSX.Element {
  if (shouldThrow()) throw new Error('kaboom');
  return <Text>recovered content</Text>;
}

describe('ErrorBoundary', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    // React prints the caught render error to console.error; keep the test output clean.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('renders children when nothing throws', async () => {
    await render(
      <ErrorBoundary>
        <Text>happy path</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText('happy path')).toBeTruthy();
  });

  it('shows the fallback UI when a child throws', async () => {
    await render(
      <ErrorBoundary>
        <Boom shouldThrow={() => true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('Try Again')).toBeTruthy();
    expect(screen.getByLabelText('Try again')).toBeTruthy();
    // The throwing child's content is gone; the app did not crash.
    expect(screen.queryByText('recovered content')).toBeNull();
  });

  it('"Try Again" clears the error and re-renders the children', async () => {
    let throwing = true;
    await render(
      <ErrorBoundary>
        <Boom shouldThrow={() => throwing} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    // The underlying problem is fixed, then the user taps Try Again.
    throwing = false;
    fireEvent.press(screen.getByLabelText('Try again'));

    // The reset → re-render is async under React 19's concurrent root; wait for it.
    expect(await screen.findByText('recovered content')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
