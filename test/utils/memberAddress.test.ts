import { mailtoUrlForAddress, memberAddressKind, telUrlForAddress } from '@utils';

describe('memberAddressKind', () => {
  it('tells dialable numbers, email addresses and everything else apart', () => {
    expect(memberAddressKind('+15551112222')).toBe('phone');
    expect(memberAddressKind('(555) 111-2222')).toBe('phone');
    expect(memberAddressKind('craig@apple.com')).toBe('email');
    expect(memberAddressKind('37542')).toBe('other'); // a business short code
    expect(memberAddressKind('urn:biz:123')).toBe('other');
    expect(memberAddressKind('')).toBe('other');
  });
});

describe('telUrlForAddress', () => {
  it('keeps only digits and one leading plus', () => {
    expect(telUrlForAddress('+1 (555) 111-2222')).toBe('tel:+15551112222');
    expect(telUrlForAddress('555.111.2222')).toBe('tel:5551112222');
    expect(telUrlForAddress('555-111-2222\n')).toBe('tel:5551112222'); // surrounding space is trimmed
  });

  it('refuses short codes, overlong numbers and anything with other characters', () => {
    expect(telUrlForAddress('37542')).toBeNull();
    expect(telUrlForAddress('+1234567890123456')).toBeNull();
    expect(telUrlForAddress('5551112222;ext=1')).toBeNull();
    expect(telUrlForAddress('tel:5551112222')).toBeNull();
    expect(telUrlForAddress('craig@apple.com')).toBeNull();
  });
});

describe('mailtoUrlForAddress', () => {
  it('builds a mailto link for a plain address', () => {
    expect(mailtoUrlForAddress(' craig@apple.com ')).toBe('mailto:craig@apple.com');
  });

  it('refuses anything that could add a header, a second recipient or break out of the address', () => {
    expect(mailtoUrlForAddress('a@b.com?cc=x@y.com')).toBeNull();
    expect(mailtoUrlForAddress('a@b.com,x@y.com')).toBeNull();
    expect(mailtoUrlForAddress('a@b.com&body=hi')).toBeNull();
    expect(mailtoUrlForAddress('"a"@b.com')).toBeNull();
    expect(mailtoUrlForAddress('a@@b.com')).toBeNull();
    expect(mailtoUrlForAddress('a b@c.com')).toBeNull();
    expect(mailtoUrlForAddress('a@localhost')).toBeNull();
    expect(mailtoUrlForAddress('+15551112222')).toBeNull();
  });
});
