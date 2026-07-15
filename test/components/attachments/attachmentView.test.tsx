/**
 * AttachmentView (src/ui/attachments/AttachmentView.tsx): the MIME-type dispatcher. It calls
 * `attachmentKind(att.mimeType)` (src/utils/attachment.ts) and renders exactly one child per kind:
 *   image → ImageAttachment, video → VideoPlayer, contact → ContactCard, location → LocationCard,
 *   audio → AudioAttachment (lazy, behind Suspense + LoadErrorBoundary), default/unknown → FileChip.
 *
 * The dispatch logic is the test subject, so AttachmentView (and the real LoadErrorBoundary) stay
 * REAL; only the leaf children are stubbed to identifiable Text markers — every leaf imports a
 * natively-heavy module (expo-video, expo-audio, the `ky`-backed download service) with no jest
 * half. Each stub renders "CHILD:<kind>" so the chosen branch is unambiguous.
 *
 * AUDIO NOTE (honest deviation): the audio branch loads AudioAttachment via `React.lazy(() =>
 * import('./AudioAttachment'))`. Under jest there is no `--experimental-vm-modules`, so the dynamic
 * `import()` REJECTS — which is precisely what LoadErrorBoundary exists to contain: it catches the
 * rejected chunk and renders the FileChip fallback. So an audio attachment resolves to the FileChip
 * marker here. That exercises the real switch-case + the boundary's fallback path; asserting the
 * AudioAttachment leaf itself would require an on-device run (out of scope per the plan).
 */
import React from 'react';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { AttachmentRow } from '@db/repositories';

const marker = (kind: string) => {
  const RN = require('react-native');
  const r = require('react');
  return () => r.createElement(RN.Text, null, 'CHILD:' + kind);
};

jest.mock('@ui/attachments/ImageAttachment', () => ({ ImageAttachment: marker('image') }));
jest.mock('@ui/attachments/VideoPlayer', () => ({ VideoPlayer: marker('video') }));
jest.mock('@ui/attachments/ContactCard', () => ({ ContactCard: marker('contact') }));
jest.mock('@ui/attachments/LocationCard', () => ({ LocationCard: marker('location') }));
jest.mock('@ui/attachments/FileChip', () => ({ FileChip: marker('file') }));
jest.mock('@ui/attachments/AudioAttachment', () => ({ AudioAttachment: marker('audio') }));

// eslint-disable-next-line import/first
import { AttachmentView } from '@ui/attachments/AttachmentView';

function makeAtt(mimeType: string | null): AttachmentRow {
  return {
    id: 1,
    guid: 'att-1',
    messageId: 1,
    mimeType,
    transferName: 'file.bin',
    totalBytes: 1000,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
  };
}

async function renderKind(mimeType: string | null): Promise<void> {
  await renderWithTheme(<AttachmentView att={makeAtt(mimeType)} isFromMe={false} showTail />);
}

describe('AttachmentView — MIME dispatch (attachmentKind)', () => {
  it('renders ImageAttachment for an image/* type', async () => {
    await renderKind('image/png');
    expect(screen.getByText('CHILD:image')).toBeTruthy();
    // Exclusivity: no other leaf renders.
    expect(screen.queryByText('CHILD:video')).toBeNull();
    expect(screen.queryByText('CHILD:file')).toBeNull();
  });

  it('renders ImageAttachment for image/jpeg too', async () => {
    await renderKind('image/jpeg');
    expect(screen.getByText('CHILD:image')).toBeTruthy();
  });

  it('renders VideoPlayer for a video/* type', async () => {
    await renderKind('video/mp4');
    expect(screen.getByText('CHILD:video')).toBeTruthy();
  });

  it('renders ContactCard for a vCard type', async () => {
    await renderKind('text/vcard');
    expect(screen.getByText('CHILD:contact')).toBeTruthy();
  });

  it('renders ContactCard for the text/x-vcard variant', async () => {
    await renderKind('text/x-vcard');
    expect(screen.getByText('CHILD:contact')).toBeTruthy();
  });

  it('renders LocationCard for a vlocation type (checked before the vcard rule)', async () => {
    // text/x-vlocation is technically a vCard too; attachmentKind tests the more specific type
    // first, so it must dispatch to the location card, not the contact card.
    await renderKind('text/x-vlocation');
    expect(screen.getByText('CHILD:location')).toBeTruthy();
    expect(screen.queryByText('CHILD:contact')).toBeNull();
  });

  it('renders FileChip for an unrecognized (application/*) type', async () => {
    await renderKind('application/pdf');
    expect(screen.getByText('CHILD:file')).toBeTruthy();
  });

  it('renders FileChip when the mime type is null', async () => {
    await renderKind(null);
    expect(screen.getByText('CHILD:file')).toBeTruthy();
  });

  it('falls back to the FileChip for an audio/* type (lazy AudioAttachment chunk rejects under jest → LoadErrorBoundary)', async () => {
    await renderKind('audio/mp4');
    // Suspense fallback → then the rejected import trips LoadErrorBoundary → FileChip fallback.
    await waitFor(() => expect(screen.getByText('CHILD:file')).toBeTruthy());
    expect(screen.queryByText('CHILD:audio')).toBeNull();
  });
});
