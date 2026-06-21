import { parseVCard } from '@utils';

describe('parseVCard', () => {
  it('parses FN + multiple TEL + EMAIL', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Smith;John;;;',
      'FN:John Smith',
      'TEL;type=CELL:+1-555-1234',
      'TEL;type=HOME:+1-555-9999',
      'EMAIL:john@example.com',
      'END:VCARD',
    ].join('\n');
    expect(parseVCard(vcf)).toEqual({
      displayName: 'John Smith',
      org: undefined,
      phones: ['+1-555-1234', '+1-555-9999'],
      emails: ['john@example.com'],
    });
  });

  it('falls back to the structured N name when FN is absent', () => {
    expect(parseVCard('BEGIN:VCARD\nN:Smith;John;;;\nEND:VCARD').displayName).toBe('John Smith');
  });

  it('falls back to ORG, then Unknown', () => {
    expect(parseVCard('BEGIN:VCARD\nORG:Acme Inc;\nEND:VCARD').displayName).toBe('Acme Inc');
    expect(parseVCard('BEGIN:VCARD\nEND:VCARD').displayName).toBe('Unknown');
  });

  it('unfolds folded continuation lines and handles CRLF', () => {
    // CRLF + a TEL value folded across two physical lines (2nd starts with a space).
    const vcf = 'BEGIN:VCARD\r\nFN:Jane\r\nTEL:+1-555-\r\n 0000\r\nEND:VCARD';
    expect(parseVCard(vcf)).toMatchObject({ displayName: 'Jane', phones: ['+1-555-0000'] });
  });
});
