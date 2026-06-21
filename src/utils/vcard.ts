export interface VCardData {
  displayName: string;
  org?: string;
  phones: string[];
  emails: string[];
}

/** Join RFC-style folded lines (a continuation line starts with a space/tab). */
function unfold(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/**
 * Parse a vCard (.vcf / text/vcard) into a contact. Mirrors the BlueBubbles server's
 * Apple-contact format (FN / N / TEL / EMAIL / ORG). Pure + Node-testable. PHOTO is
 * intentionally skipped (multi-line base64 isn't reliably parseable and isn't needed
 * for the card). Falls back to the structured N name, then ORG, then "Unknown".
 */
export function parseVCard(content: string): VCardData {
  let fn = '';
  let n = '';
  let org = '';
  const phones: string[] = [];
  const emails: string[] = [];

  for (const line of unfold(content)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const prop = line.slice(0, colon).split(';')[0]!.toUpperCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    if (prop === 'FN') fn = value;
    else if (prop === 'N') n = value;
    else if (prop === 'ORG') org = value.split(';')[0]!.trim();
    else if (prop === 'TEL') phones.push(value);
    else if (prop === 'EMAIL') emails.push(value);
  }

  let displayName = fn;
  if (!displayName && n) {
    // N = familyName;givenName;middleName;prefix;suffix
    const [family = '', given = ''] = n.split(';');
    displayName = `${given} ${family}`.trim();
  }
  if (!displayName) displayName = org || 'Unknown';

  return { displayName, org: org || undefined, phones, emails };
}
