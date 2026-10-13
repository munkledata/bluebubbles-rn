import { isProxiedPreviewImageDataUrl } from '@/services/urlPreview';

describe('isProxiedPreviewImageDataUrl', () => {
  it.each(['data:image/jpeg;base64,/9j/2Q==', 'data:image/png;base64,iVBORw0KGgo='])(
    'accepts only bounded server-proxied JPEG/PNG bytes: %s',
    (value) => {
      expect(isProxiedPreviewImageDataUrl(value)).toBe(true);
    },
  );

  it.each([
    'https://cdn.example/image.jpg',
    'file:///private/cache/image.jpg',
    'data:image/gif;base64,R0lGODlh',
    'data:image/webp;base64,UklGRg==',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,not_base64!',
    'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,iVBORw0KGgo=',
    'data:image/png;base64,/9j/2Q==',
    'data:image/png;base64,iVBORw0KGgp=',
    '',
  ])('rejects direct, executable, or malformed artwork: %s', (value) => {
    expect(isProxiedPreviewImageDataUrl(value)).toBe(false);
  });

  it('rejects an encoded image above the cross-repository response ceiling', () => {
    expect(isProxiedPreviewImageDataUrl(`data:image/png;base64,${'A'.repeat(699_076)}`)).toBe(
      false,
    );
  });

  it('accepts exactly 512 KiB but rejects the same-length encoding that decodes one byte over', () => {
    const pngMagic = 'iVBORw0KGgo';
    const exactPayload = `${pngMagic}${'A'.repeat(699_040)}=`;
    const oneOverPayload = `${pngMagic}${'A'.repeat(699_041)}`;

    expect(isProxiedPreviewImageDataUrl(`data:image/png;base64,${exactPayload}`)).toBe(true);
    expect(isProxiedPreviewImageDataUrl(`data:image/png;base64,${oneOverPayload}`)).toBe(false);
  });
});
