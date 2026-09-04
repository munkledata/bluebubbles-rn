import { ApiError, UnimplementedEndpointError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  deleteSettingsBackup,
  listSettingsBackups,
  saveSettingsBackup,
} from '@core/api/endpoints/backups';

interface Parser {
  parse(value: unknown): unknown;
}

function parsedGet(value: unknown): jest.Mock {
  return jest.fn((_path: string, schema: Parser) => Promise.resolve(schema.parse(value)));
}

describe('backup settings endpoints', () => {
  it('preserves the revision fence and sends guarded write contracts', async () => {
    const slot = {
      name: 'Nightly / phone',
      data: 'BB2.ciphertext',
      revision: '00112233445566778899aabbccddeeff',
      createdAt: 10,
      updatedAt: 20,
    };
    const signal = new AbortController().signal;
    const get = parsedGet({ backups: [slot], revisionFence: true });
    const post = jest.fn().mockResolvedValue(slot);
    const del = jest.fn().mockResolvedValue({ removed: true });
    const http = { get, post, delete: del } as unknown as HttpClient;

    await expect(listSettingsBackups(http, signal)).resolves.toEqual({
      backups: [slot],
      revisionFence: true,
    });
    await expect(
      saveSettingsBackup(
        http,
        { name: slot.name, data: slot.data, expectedRevision: slot.revision },
        signal,
      ),
    ).resolves.toEqual(slot);
    await expect(
      deleteSettingsBackup(http, { name: slot.name, expectedRevision: slot.revision }, signal),
    ).resolves.toBe(true);

    expect(get).toHaveBeenCalledWith('/backup/settings', expect.anything(), { signal });
    expect(post).toHaveBeenCalledWith('/backup/settings', expect.anything(), {
      json: { name: slot.name, data: slot.data, expectedRevision: slot.revision },
      signal,
    });
    expect(del).toHaveBeenCalledWith('/backup/settings/Nightly%20%2F%20phone', expect.anything(), {
      query: { expectedRevision: slot.revision },
      signal,
    });
  });

  it('preserves fenced and legacy capability even when a list is empty', async () => {
    const fencedHttp = {
      get: parsedGet({ backups: [], revisionFence: true }),
    } as unknown as HttpClient;
    await expect(listSettingsBackups(fencedHttp)).resolves.toEqual({
      backups: [],
      revisionFence: true,
    });

    const legacySlot = { name: 'Old', data: 'legacy', createdAt: 1, updatedAt: 2 };
    const get = parsedGet({ backups: [legacySlot] });
    const legacyHttp = { get } as unknown as HttpClient;

    await expect(listSettingsBackups(legacyHttp)).resolves.toEqual({
      backups: [legacySlot],
      revisionFence: false,
    });
  });

  it('rejects a fenced list whose rows do not carry canonical revisions', async () => {
    const malformed = {
      backups: [{ name: 'Missing revision', data: 'BB2.ciphertext', createdAt: 1, updatedAt: 2 }],
      revisionFence: true,
    };
    const http = { get: parsedGet(malformed) } as unknown as HttpClient;

    await expect(listSettingsBackups(http)).rejects.toBeDefined();
  });

  it('degrades a missing or legacy-incompatible route as unsupported', async () => {
    const missing = {
      get: jest.fn().mockRejectedValue(new ApiError('bad_request', 'missing', 404)),
    } as unknown as HttpClient;
    const legacy = { get: parsedGet([]) } as unknown as HttpClient;
    const malformedCurrent = {
      get: jest.fn().mockRejectedValue(new ApiError('parse_error', 'oversized list', 200)),
    } as unknown as HttpClient;

    await expect(listSettingsBackups(missing)).rejects.toBeInstanceOf(UnimplementedEndpointError);
    await expect(listSettingsBackups(legacy)).rejects.toBeInstanceOf(UnimplementedEndpointError);
    await expect(listSettingsBackups(malformedCurrent)).rejects.toMatchObject({
      kind: 'parse_error',
    });
  });
});
