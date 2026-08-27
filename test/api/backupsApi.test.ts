import { ApiError, UnimplementedEndpointError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  deleteSettingsBackup,
  listSettingsBackups,
  saveSettingsBackup,
} from '@core/api/endpoints/backups';

describe('backup settings endpoints', () => {
  it('uses the current list/upsert/encoded-delete contract and forwards cancellation', async () => {
    const slot = { name: 'Nightly / phone', data: 'BB2.ciphertext', createdAt: 10, updatedAt: 20 };
    const signal = new AbortController().signal;
    const get = jest.fn().mockResolvedValue({ backups: [slot] });
    const post = jest.fn().mockResolvedValue(slot);
    const del = jest.fn().mockResolvedValue({ removed: true });
    const http = { get, post, delete: del } as unknown as HttpClient;

    await expect(listSettingsBackups(http, signal)).resolves.toEqual([slot]);
    await expect(
      saveSettingsBackup(http, { name: slot.name, data: slot.data }, signal),
    ).resolves.toEqual(slot);
    await expect(deleteSettingsBackup(http, slot.name, signal)).resolves.toBe(true);

    expect(get).toHaveBeenCalledWith('/backup/settings', expect.anything(), { signal });
    expect(post).toHaveBeenCalledWith('/backup/settings', expect.anything(), {
      json: { name: slot.name, data: slot.data },
      signal,
    });
    expect(del).toHaveBeenCalledWith('/backup/settings/Nightly%20%2F%20phone', expect.anything(), {
      signal,
    });
  });

  it('degrades a missing or legacy-incompatible route as unsupported', async () => {
    const missing = {
      get: jest.fn().mockRejectedValue(new ApiError('bad_request', 'missing', 404)),
    } as unknown as HttpClient;
    const legacy = { get: jest.fn().mockResolvedValue([]) } as unknown as HttpClient;
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
