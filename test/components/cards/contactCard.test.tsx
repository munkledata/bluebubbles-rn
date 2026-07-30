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
 *   - tap CONTRACT (onPress in source): localPath present → openAttachmentFile(localPath, mime),
 *     which converts the app-private path to a content:// FileProvider uri (a file:// uri cannot be
 *     handed to another app); absent → download(att). The RESULT is consumed: 'missing'
 *     re-downloads, 'no_handler' toasts.
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
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
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

// The open path. Mocked wholesale so no native module enters this graph; the real behaviour is
// covered by the node test at test/services/openFile.test.ts.
const mockOpenAttachmentFile = jest.fn();
jest.mock('@/services/openFile', () => ({
  openAttachmentFile: (...args: unknown[]) => mockOpenAttachmentFile(...args),
}));

// eslint-disable-next-line import/first
import { ContactCard } from '@ui/attachments/ContactCard';
// eslint-disable-next-line import/first
import { download } from '@/services/download';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

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
  mockVcfText =
    'BEGIN:VCARD\nFN:John Smith\nTEL;type=CELL:+1-555-1234\nEMAIL:john@example.com\nEND:VCARD';
  (download as jest.Mock).mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
});

describe('ContactCard — parsed vCard once local', () => {
  it('renders the displayName, first phone, initials and a11y label', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    // The effect reads + parses async → wait for the parsed name.
    expect(await screen.findByText('John Smith')).toBeTruthy();
    expect(screen.getByText('+1-555-1234')).toBeTruthy(); // first phone is the subtitle
    expect(screen.getByText('JS')).toBeTruthy(); // two-initial avatar
    expect(screen.getByLabelText('Contact: John Smith')).toBeTruthy();
  });

  it('falls back to the first email as subtitle when there is no phone', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:Jane Roe\nEMAIL:jane@example.com\nEND:VCARD';
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/j.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('Jane Roe')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
  });

  it('shows "Contact card" subtitle when the vCard has neither phone nor email', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:No Contact\nEND:VCARD';
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/n.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('No Contact')).toBeTruthy();
    expect(screen.getByText('Contact card')).toBeTruthy();
  });

  it('a read failure leaves the contact null → falls back to transferName + status text', async () => {
    mockVcfText = () => Promise.reject(new Error('read failed'));
    await renderWithTheme(
      <ContactCard
        att={makeAtt({ localPath: 'file:///c/bad.vcf', transferName: 'bob.vcf' })}
        isFromMe={false}
      />,
    );
    // contact stays null → title = transferName, subtitle = idle status text.
    expect(await screen.findByText('bob.vcf')).toBeTruthy();
    expect(screen.getByText('Tap to view contact')).toBeTruthy();
  });
});

describe('ContactCard — not-yet-local (status-driven subtitle)', () => {
  it('idle: title from transferName and "Tap to view contact"', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ transferName: 'bob.vcf' })} isFromMe={false} />,
    );
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
  beforeEach(() => {
    useToastStore.setState({ current: null, queue: [] });
    mockOpenAttachmentFile.mockResolvedValue({ status: 'opened' });
  });

  it('no localPath → download(att)', async () => {
    const att = makeAtt({ transferName: null }); // title defaults to "Contact"
    await renderWithTheme(<ContactCard att={att} isFromMe={false} />);
    fireEvent.press(screen.getByLabelText('Contact: Contact'));
    expect(download).toHaveBeenCalledWith(att);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
  });

  // FAILS ON THE OLD CODE, which handed the app-private file:// path to safeOpenUrl — a uri
  // Android forbids passing to another app, so the tap silently did nothing.
  it('localPath present → openAttachmentFile, never safeOpenUrl', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('John Smith');
    fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith('file:///c/contact.vcf', 'text/vcard');
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('a missing local file re-downloads (the inline card would be empty too)', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'missing' });
    const att = makeAtt({ localPath: 'file:///c/contact.vcf' });
    await renderWithTheme(<ContactCard att={att} isFromMe={false} />);
    await screen.findByText('John Smith');
    fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    await waitFor(() => expect(download).toHaveBeenCalledWith(att));
  });

  it('toasts when nothing on the device can open a contact card', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'no_handler' });
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('John Smith');
    fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    await waitFor(() => expect(useToastStore.getState().current?.message).toMatch(/contact cards/));
  });
});

describe('ContactCard — alignment follows isFromMe', () => {
  const alignOf = (): ViewStyle['alignSelf'] =>
    (StyleSheet.flatten(screen.getByLabelText('Contact: Contact').props.style) as ViewStyle)
      .alignSelf;

  it('flex-end when from me', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={true} />);
    expect(alignOf()).toBe('flex-end');
  });

  it('flex-start when from them', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={false} />);
    expect(alignOf()).toBe('flex-start');
  });
});
