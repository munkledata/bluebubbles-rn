/**
 * ContactCard (src/ui/attachments/ContactCard.tsx): a vCard (.vcf) attachment shown as an
 * iOS-style contact chip. Behaviors locked in, all derived from the SOURCE:
 *   - once local, the .vcf text is read (expo-file-system `File`) and parsed with the pure
 *     parseVCard (src/utils/vcard.ts) → title = displayName, subtitle = first phone (else first
 *     email, else "Contact card"), avatar = up-to-2 initials of the title, a11y "Contact: <name>".
 *   - BEFORE it's local (no localPath) the subtitle is status-driven: idle → "Tap to view contact",
 *     downloading → "Downloading…" (+ spinner), error → "Tap to retry"; title falls back to
 *     att.transferName ?? "Contact".
 *   - a file-read failure resets the parsed contact to null (falls back to the status/transferName
 *     text) rather than crashing.
 *   - tap CONTRACT (onPress in source): localPath present → safeOpenUrl(localPath) (opens the card);
 *     absent → download(att) (fetches the .vcf first).
 *   - alignSelf follows isFromMe (flex-end for me, flex-start for them).
 *
 * In-file mocks: `expo-file-system` (controlled .vcf text via `mockVcfText`, so no disk),
 * `@/services/download` (its barrel pulls native/ESM services — only the `download` fn identity
 * matters), and `safeOpenUrl` on the `@utils` barrel (its REAL impl lazy-imports react-native via
 * a dynamic `import()`, which throws under the jest-expo VM — so the open contract is asserted at
 * the safeOpenUrl boundary; parseVCard stays the REAL util via requireActual).
 */
import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

// The parsed contact comes from this text; a function value lets a test make `.text()` reject.
let mockVcfText: string | (() => Promise<string>) =
  'BEGIN:VCARD\nFN:John Smith\nTEL;type=CELL:+1-555-1234\nEMAIL:john@example.com\nEND:VCARD';

jest.mock('expo-file-system', () => ({
  File: class {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
    async text(): Promise<string> {
      if (typeof mockVcfText === 'function') return mockVcfText();
      return mockVcfText;
    }
  },
}));

// The services barrel loads native modules at import; only the fn identity is used here.
jest.mock('@/services/download', () => ({ download: jest.fn() }));

// safeOpenUrl's real impl dynamic-imports react-native (throws under the jest-expo VM); mock ONLY it,
// keeping every other @utils export (parseVCard, etc.) real.
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// eslint-disable-next-line import/first
import { ContactCard } from '@ui/attachments/ContactCard';
// eslint-disable-next-line import/first
import { download } from '@/services/download';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';

function makeAtt(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-vcf-1',
    messageId: 1,
    mimeType: 'text/vcard',
    transferName: 'contact.vcf',
    totalBytes: 123,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Only the theme store is reset by the shared setup; this suite owns the download store + mocks.
  useDownloadStore.setState({ progress: {}, status: {} });
  mockVcfText = 'BEGIN:VCARD\nFN:John Smith\nTEL;type=CELL:+1-555-1234\nEMAIL:john@example.com\nEND:VCARD';
  (download as jest.Mock).mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
});

describe('ContactCard — parsed vCard once local', () => {
  it('renders the displayName, first phone, initials and a11y label', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />);
    // The effect reads + parses async → wait for the parsed name.
    expect(await screen.findByText('John Smith')).toBeTruthy();
    expect(screen.getByText('+1-555-1234')).toBeTruthy(); // first phone is the subtitle
    expect(screen.getByText('JS')).toBeTruthy(); // two-initial avatar
    expect(screen.getByLabelText('Contact: John Smith')).toBeTruthy();
  });

  it('falls back to the first email as subtitle when there is no phone', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:Jane Roe\nEMAIL:jane@example.com\nEND:VCARD';
    await renderWithTheme(<ContactCard att={makeAtt({ localPath: 'file:///c/j.vcf' })} isFromMe={false} />);
    expect(await screen.findByText('Jane Roe')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
  });

  it('shows "Contact card" subtitle when the vCard has neither phone nor email', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:No Contact\nEND:VCARD';
    await renderWithTheme(<ContactCard att={makeAtt({ localPath: 'file:///c/n.vcf' })} isFromMe={false} />);
    expect(await screen.findByText('No Contact')).toBeTruthy();
    expect(screen.getByText('Contact card')).toBeTruthy();
  });

  it('a read failure leaves the contact null → falls back to transferName + status text', async () => {
    mockVcfText = () => Promise.reject(new Error('read failed'));
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/bad.vcf', transferName: 'bob.vcf' })} isFromMe={false} />,
    );
    // contact stays null → title = transferName, subtitle = idle status text.
    expect(await screen.findByText('bob.vcf')).toBeTruthy();
    expect(screen.getByText('Tap to view contact')).toBeTruthy();
  });
});

describe('ContactCard — not-yet-local (status-driven subtitle)', () => {
  it('idle: title from transferName and "Tap to view contact"', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: 'bob.vcf' })} isFromMe={false} />);
    expect(screen.getByText('bob.vcf')).toBeTruthy();
    expect(screen.getByText('Tap to view contact')).toBeTruthy();
  });

  it('title defaults to "Contact" when there is no transferName', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={false} />);
    expect(screen.getByText('Contact')).toBeTruthy();
  });

  it('downloading: shows "Downloading…"', async () => {
    useDownloadStore.setState({ status: { 'att-vcf-1': 'downloading' } });
    await renderWithTheme(<ContactCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Downloading…')).toBeTruthy();
  });

  it('error: shows "Tap to retry"', async () => {
    useDownloadStore.setState({ status: { 'att-vcf-1': 'error' } });
    await renderWithTheme(<ContactCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Tap to retry')).toBeTruthy();
  });
});

describe('ContactCard — tap contract', () => {
  it('no localPath → download(att)', async () => {
    const att = makeAtt({ transferName: null }); // title defaults to "Contact"
    await renderWithTheme(<ContactCard att={att} isFromMe={false} />);
    fireEvent.press(screen.getByLabelText('Contact: Contact'));
    expect(download).toHaveBeenCalledWith(att);
    expect(safeOpenUrl).not.toHaveBeenCalled();
  });

  it('localPath present → safeOpenUrl(localPath) opens the card, no download', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />);
    await screen.findByText('John Smith');
    fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    expect(safeOpenUrl).toHaveBeenCalledWith('file:///c/contact.vcf');
    expect(download).not.toHaveBeenCalled();
  });
});

describe('ContactCard — alignment follows isFromMe', () => {
  const alignOf = (): ViewStyle['alignSelf'] =>
    (StyleSheet.flatten(screen.getByLabelText('Contact: Contact').props.style) as ViewStyle).alignSelf;

  it('flex-end when from me', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={true} />);
    expect(alignOf()).toBe('flex-end');
  });

  it('flex-start when from them', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={false} />);
    expect(alignOf()).toBe('flex-start');
  });
});
