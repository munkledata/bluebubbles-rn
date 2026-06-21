import { parseVLocation } from '@utils';

describe('parseVLocation', () => {
  // Apple's createAppleLocation(longitude, latitude) → ll=<lon>,<lat>, comma escaped.
  it('parses ll=longitude,latitude with a backslash-escaped comma', () => {
    const vcf =
      'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=-122.4194\\,37.7749&q=-122.4194\\,37.7749\nEND:VCARD';
    expect(parseVLocation(vcf)).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      url: 'https://maps.apple.com/?ll=-122.4194\\,37.7749&q=-122.4194\\,37.7749',
    });
  });

  it('handles a plain comma and %2C separator', () => {
    expect(parseVLocation('URL:https://maps.apple.com/?ll=10.5,20.25')).toMatchObject({
      longitude: 10.5,
      latitude: 20.25,
    });
    expect(parseVLocation('URL:https://maps.apple.com/?ll=1.0%2C2.0')).toMatchObject({
      longitude: 1,
      latitude: 2,
    });
  });

  it('returns null when there is no URL line or no coordinates', () => {
    expect(parseVLocation('BEGIN:VCARD\nFN:Not a location\nEND:VCARD')).toBeNull();
    expect(parseVLocation('URL:https://maps.apple.com/?q=somewhere')).toBeNull();
  });
});
