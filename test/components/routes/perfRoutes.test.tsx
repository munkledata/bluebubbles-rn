import { Redirect } from 'expo-router';
import { ColdInboxBenchmarkScreen } from '@ui/conversations/ColdInboxBenchmarkScreen';
import { PerfInboxBenchmarkScreen } from '@ui/conversations/PerfInboxBenchmarkScreen';
import PerfInboxRoute from '../../../app/(app)/perf-inbox';
import PerfInboxColdRoute from '../../../app/(app)/perf-inbox-cold';
import { renderWithTheme } from '../support/renderWithTheme';

jest.mock('expo-router', () => ({ Redirect: jest.fn(() => null) }));
jest.mock('@ui/conversations/ColdInboxBenchmarkScreen', () => ({
  ColdInboxBenchmarkScreen: jest.fn(() => null),
}));
jest.mock('@ui/conversations/PerfInboxBenchmarkScreen', () => ({
  PerfInboxBenchmarkScreen: jest.fn(() => null),
}));

const originalDev = __DEV__;
afterEach(() => {
  Object.assign(globalThis, { __DEV__: originalDev });
});

it.each([
  ['cold', PerfInboxColdRoute, ColdInboxBenchmarkScreen],
  ['warm', PerfInboxRoute, PerfInboxBenchmarkScreen],
] as const)('restricts the %s benchmark route to development', async (_name, Route, Screen) => {
  Object.assign(globalThis, { __DEV__: false });
  const view = await renderWithTheme(<Route />);
  expect(Redirect).toHaveBeenCalledWith(expect.objectContaining({ href: '/home' }), undefined);
  expect(ColdInboxBenchmarkScreen).not.toHaveBeenCalled();
  expect(PerfInboxBenchmarkScreen).not.toHaveBeenCalled();

  Object.assign(globalThis, { __DEV__: true });
  await view.rerender(<Route />);
  expect(Screen).toHaveBeenCalledTimes(1);
});
