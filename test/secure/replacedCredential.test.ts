import {
  createReplacedCredentialRecord,
  InMemoryVault,
  inspectReplacedCredentialRecord,
  retireReplacedCredentialRecord,
  serializeReplacedCredentialRecord,
  type SecureVault,
} from '@core/secure';

const ORIGIN = 'https://gator.example';
const OLD = `bbd_device_v1_${'B'.repeat(43)}`;

describe('replaced-credential custody record (M130)', () => {
  it('round-trips the exact canonical record', () => {
    const record = createReplacedCredentialRecord(ORIGIN, OLD);
    const stored = serializeReplacedCredentialRecord(record);
    expect(stored).toBe(`{"version":1,"origin":"${ORIGIN}","credential":"${OLD}"}`);
    expect(inspectReplacedCredentialRecord(stored)).toEqual({ kind: 'valid', record });
  });

  it('is absent when nothing is stored', () => {
    expect(inspectReplacedCredentialRecord(null)).toEqual({ kind: 'absent' });
  });

  it('refuses anything but a canonical origin and one scoped device credential', () => {
    expect(() => createReplacedCredentialRecord('https://gator.example/', OLD)).toThrow();
    expect(() => createReplacedCredentialRecord('https://gаtor.example', OLD)).toThrow();
    expect(() => createReplacedCredentialRecord(ORIGIN, 'shared password')).toThrow();
  });

  it.each([
    ['empty text', ''],
    ['not JSON', 'nope'],
    ['an unknown version', `{"version":2,"origin":"${ORIGIN}","credential":"${OLD}"}`],
    ['an extra key', `{"version":1,"origin":"${ORIGIN}","credential":"${OLD}","x":1}`],
    ['a missing key', `{"version":1,"origin":"${ORIGIN}"}`],
    ['a reordered key', `{"origin":"${ORIGIN}","version":1,"credential":"${OLD}"}`],
    ['whitespace', `{"version": 1,"origin":"${ORIGIN}","credential":"${OLD}"}`],
    ['a shared password', `{"version":1,"origin":"${ORIGIN}","credential":"secret"}`],
    ['oversized text', `"${'x'.repeat(9 * 1024)}"`],
  ])('reports %s as invalid, never as absent', (_label, stored) => {
    expect(inspectReplacedCredentialRecord(stored)).toEqual({ kind: 'invalid' });
  });
});

describe('retiring the record (M130 review)', () => {
  const stored = () =>
    serializeReplacedCredentialRecord(createReplacedCredentialRecord(ORIGIN, OLD));

  async function vaultWithRecord(
    overrides: Partial<Pick<SecureVault, 'set' | 'delete'>> = {},
  ): Promise<{ vault: SecureVault; backing: InMemoryVault }> {
    const backing = new InMemoryVault();
    await backing.set('replacedServerCredential', stored());
    return {
      backing,
      vault: {
        get: (key) => backing.get(key),
        set: overrides.set ?? ((key, value) => backing.set(key, value)),
        delete: overrides.delete ?? ((key) => backing.delete(key)),
      },
    };
  }

  it('is done when there is no record, and deletes one that exists', async () => {
    await expect(retireReplacedCredentialRecord(new InMemoryVault())).resolves.toBe(true);
    const { vault, backing } = await vaultWithRecord();
    await expect(retireReplacedCredentialRecord(vault)).resolves.toBe(true);
    expect(await backing.get('replacedServerCredential')).toBeNull();
  });

  it.each([
    ['ignores the delete', async () => undefined],
    [
      'throws on delete',
      async () => {
        throw new Error('Keystore delete unavailable');
      },
    ],
  ])('overwrites a record when the keystore %s, leaving nothing to send', async (_label, del) => {
    const { vault, backing } = await vaultWithRecord({ delete: del });
    await expect(retireReplacedCredentialRecord(vault)).resolves.toBe(true);
    expect(await backing.get('replacedServerCredential')).toBe('');
    expect(inspectReplacedCredentialRecord('')).toEqual({ kind: 'invalid' });
  });

  it('reports failure when the record can be neither removed nor overwritten', async () => {
    const { vault, backing } = await vaultWithRecord({
      delete: async () => undefined,
      set: async () => {
        throw new Error('Keystore write unavailable');
      },
    });
    await expect(retireReplacedCredentialRecord(vault)).resolves.toBe(false);
    expect(await backing.get('replacedServerCredential')).toBe(stored());
  });
});
