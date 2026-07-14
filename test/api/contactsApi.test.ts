import { contactAvatarUrl, queryContactsByAddress } from '@core/api/endpoints/contacts';
import type { HttpClient } from '@core/api/http';

describe('contactsApi.queryContactsByAddress', () => {
  it('POSTs /contact/query with the addresses and returns the contacts', async () => {
    const contacts = [{ id: 'c1', displayName: 'Alice', phoneNumbers: ['+1555'] }];
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ contacts }));
    const http = { post } as unknown as HttpClient;
    const res = await queryContactsByAddress(http, ['+1555', 'a@b.com']);
    expect(post).toHaveBeenCalledWith('/contact/query', expect.anything(), {
      json: { addresses: ['+1555', 'a@b.com'] },
    });
    expect(res).toEqual(contacts);
  });

  it('returns [] when the server sends no contacts key', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ contacts: null }));
    const http = { post } as unknown as HttpClient;
    expect(await queryContactsByAddress(http, ['+1555'])).toEqual([]);
  });
});

describe('contactsApi.contactAvatarUrl', () => {
  const http = {
    buildUrl: (path: string) => `https://server.example/api/v1${path}`,
  } as unknown as HttpClient;

  it('builds the authless avatar URL with the default thumb size', () => {
    expect(contactAvatarUrl(http, 'abc')).toBe(
      'https://server.example/api/v1/contact/abc/avatar?size=thumb',
    );
  });

  it('URL-encodes the contact id (ids can contain : and /)', () => {
    expect(contactAvatarUrl(http, 'AB:12/34', 'full')).toBe(
      'https://server.example/api/v1/contact/AB%3A12%2F34/avatar?size=full',
    );
  });
});
