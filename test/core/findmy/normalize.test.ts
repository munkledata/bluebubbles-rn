import { normalizeDevice, normalizeFriend } from '@core/findmy';

describe('normalizeDevice', () => {
  it('extracts name, battery, and location', () => {
    const raw = {
      id: 'x',
      name: 'iPhone',
      batteryLevel: 0.75,
      location: { latitude: 1.5, longitude: -2.5 },
      address: 'Cupertino',
    };
    expect(normalizeDevice(raw, 0)).toEqual({
      id: 'x',
      name: 'iPhone',
      batteryLevel: 0.75,
      latitude: 1.5,
      longitude: -2.5,
      address: 'Cupertino',
    });
  });

  it('falls back for missing fields', () => {
    const d = normalizeDevice({ deviceModel: 'Mac' }, 3);
    expect(d.name).toBe('Mac');
    expect(d.id).toBe('device-3');
    expect(d.batteryLevel).toBeNull();
    expect(d.latitude).toBeNull();
  });

  it('handles a nested address object', () => {
    const d = normalizeDevice({ name: 'A', address: { label: 'Home' } }, 0);
    expect(d.address).toBe('Home');
  });
});

describe('normalizeFriend', () => {
  it('maps coordinates + addresses', () => {
    const raw = {
      handle: { address: '+1' },
      title: 'Mom',
      short_address: 'Palo Alto',
      coordinates: [37.44, -122.14],
      last_updated: 123,
    };
    expect(normalizeFriend(raw, 0)).toEqual({
      id: '+1',
      name: 'Mom',
      handle: '+1',
      address: 'Palo Alto',
      latitude: 37.44,
      longitude: -122.14,
      lastUpdated: 123,
    });
  });

  it('handles a friend with no location', () => {
    const f = normalizeFriend({ title: 'Tim' }, 1);
    expect(f).toEqual({
      id: 'Tim',
      name: 'Tim',
      handle: null,
      address: null,
      latitude: null,
      longitude: null,
      lastUpdated: null,
    });
  });

  it("keeps the Gator server's plain-string handle", () => {
    const f = normalizeFriend({ handle: 'pat@example.com', title: 'Pat', coordinates: null }, 0);
    expect(f.handle).toBe('pat@example.com');
    expect(f.name).toBe('Pat');
  });

  it('never names a person after a place: the handle comes before a short address', () => {
    const f = normalizeFriend({ handle: '+15551234567', shortAddress: 'Palo Alto' }, 0);
    expect(f.name).toBe('+15551234567');
    expect(f.address).toBe('Palo Alto');
  });
});
