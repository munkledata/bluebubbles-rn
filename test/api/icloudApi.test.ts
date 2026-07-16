import { AccountInfo, getAccountInfo, setActiveAlias } from '@core/api/endpoints/icloud';
import type { HttpClient } from '@core/api/http';

describe('icloudApi', () => {
  it('getAccountInfo GETs /icloud/account', async () => {
    const get = jest.fn(() => Promise.resolve({ activeAlias: 'a@b.com', aliases: ['a@b.com'] }));
    const http = { get } as unknown as HttpClient;
    await getAccountInfo(http);
    expect(get).toHaveBeenCalledWith('/icloud/account', expect.anything());
  });

  it('setActiveAlias POSTs /icloud/account/alias with the chosen alias', async () => {
    const post = jest.fn(() => Promise.resolve({ activeAlias: '+15551234567' }));
    const http = { post } as unknown as HttpClient;
    await setActiveAlias(http, '+15551234567');
    expect(post).toHaveBeenCalledWith('/icloud/account/alias', expect.anything(), {
      json: { alias: '+15551234567' },
    });
  });

  it('AccountInfo parses leniently: missing aliases → [], nulls tolerated', () => {
    const parsed = AccountInfo.parse({ appleId: null, activeAlias: null });
    expect(parsed.aliases).toEqual([]);
    expect(parsed.appleId).toBeNull();
    expect(parsed.vettedAliases).toBeUndefined();
  });

  it('AccountInfo keeps a provided alias list + vetted subset', () => {
    const parsed = AccountInfo.parse({
      appleId: 'you@icloud.com',
      displayName: 'You',
      activeAlias: 'you@icloud.com',
      aliases: ['you@icloud.com', '+15551234567'],
      vettedAliases: ['you@icloud.com'],
      loginStatusMessage: 'Connected',
    });
    expect(parsed.aliases).toEqual(['you@icloud.com', '+15551234567']);
    expect(parsed.vettedAliases).toEqual(['you@icloud.com']);
  });
});
