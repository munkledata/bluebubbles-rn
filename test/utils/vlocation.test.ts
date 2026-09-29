import { parseVLocation } from '@utils';

describe('parseVLocation', () => {
  it('parses Apple ll=latitude,longitude with a backslash-escaped comma', () => {
    const vcf =
      'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=37.7749\\,-122.4194&q=37.7749\\,-122.4194\nEND:VCARD';
    expect(parseVLocation(vcf)).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      url: 'https://maps.apple.com/?ll=37.7749\\,-122.4194&q=37.7749\\,-122.4194',
    });
  });

  it('handles a plain comma and %2C separator', () => {
    expect(parseVLocation('URL:https://maps.apple.com/?ll=10.5,20.25')).toMatchObject({
      latitude: 10.5,
      longitude: 20.25,
    });
    expect(parseVLocation('URL:https://maps.apple.com/?ll=1.0%2C2.0')).toMatchObject({
      latitude: 1,
      longitude: 2,
    });
  });

  it('accepts boundary coordinates and rejects malformed or out-of-range coordinates', () => {
    expect(parseVLocation('URL:https://maps.apple.com/?ll=-90,180')).toMatchObject({
      latitude: -90,
      longitude: 180,
    });
    expect(parseVLocation('URL:https://maps.apple.com/?ll=90.0001,0')).toBeNull();
    expect(parseVLocation('URL:https://maps.apple.com/?ll=0,-180.0001')).toBeNull();
    expect(parseVLocation('URL:https://maps.apple.com/?ll=1.2.3,4')).toBeNull();
  });

  it('returns null when there is no URL line or no coordinates', () => {
    expect(parseVLocation('BEGIN:VCARD\nFN:Not a location\nEND:VCARD')).toBeNull();
    expect(parseVLocation('URL:https://maps.apple.com/?q=somewhere')).toBeNull();
  });
});
