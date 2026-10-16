import {
  createReplacedCredentialRecord,
  inspectReplacedCredentialRecord,
  serializeReplacedCredentialRecord,
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
