/**
 * TLS pinning wiring. The native module is mocked; these verify the pure option
 * builder and that pinning is applied only when pins exist (so a no-pin build never
 * touches native).
 */
const mockInit = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockListener = jest.fn((..._a: unknown[]) => ({ remove: jest.fn() }));
jest.mock('react-native-ssl-public-key-pinning', () => ({
  isSslPinningAvailable: () => true,
  initializeSslPinning: mockInit,
  addSslPinningErrorListener: mockListener,
}));

import { applyCertPinning, buildPinningOptions } from '@native/certPinning';

describe('cert pinning', () => {
  beforeEach(() => {
    mockInit.mockClear();
    mockListener.mockClear();
  });

  it('builds PinningOptions with includeSubdomains and drops empty hosts', () => {
    expect(buildPinningOptions({ 'a.com': ['sha256/AAA='], 'b.com': [] })).toEqual({
      'a.com': { includeSubdomains: true, publicKeyHashes: ['sha256/AAA='] },
    });
  });

  it('no-ops on empty pins and never touches the native module', async () => {
    expect(await applyCertPinning({})).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('initializes pinning + attaches the mismatch listener when pins are present', async () => {
    expect(await applyCertPinning({ 'srv.example.com': ['sha256/AAA='] })).toBe(true);
    expect(mockInit).toHaveBeenCalledWith({
      'srv.example.com': { includeSubdomains: true, publicKeyHashes: ['sha256/AAA='] },
    });
    expect(mockListener).toHaveBeenCalled();
  });
});
