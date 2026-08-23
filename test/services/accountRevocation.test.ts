import { readAccountRevocationState, type AccountRevocationMarker } from '@core/secure';

describe('independent account-revocation policy', () => {
  it('reports a missing marker as clear', () => {
    const marker: Pick<AccountRevocationMarker, 'isRevoked'> = {
      isRevoked: () => false,
    };

    expect(readAccountRevocationState(marker)).toBe('clear');
  });

  it('reports an existing marker as revoked', () => {
    const marker: Pick<AccountRevocationMarker, 'isRevoked'> = {
      isRevoked: () => true,
    };

    expect(readAccountRevocationState(marker)).toBe('revoked');
  });

  it('fails closed when marker state is unreadable', () => {
    const marker: Pick<AccountRevocationMarker, 'isRevoked'> = {
      isRevoked: () => {
        throw new Error('documents directory unavailable');
      },
    };

    expect(readAccountRevocationState(marker)).toBe('unavailable');
  });
});
