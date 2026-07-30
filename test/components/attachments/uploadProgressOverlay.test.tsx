/**
 * UploadProgressOverlay (src/ui/attachments/UploadProgressOverlay.tsx): the outgoing twin of the
 * download ring — what an attachment bubble shows while its file is being SENT.
 *
 * Behaviors locked in:
 *   - a known total renders a determinate ProgressRing (percentage) plus the byte readout;
 *   - an unknown total (0) renders the spinner with NO percentage, and the readout degrades to the
 *     sent amount alone rather than printing a bogus "0 B of 0 B";
 *   - `compact` drops the byte readout (a gallery cell / inline Genmoji has no room) but keeps the
 *     ring, so the cell still shows something is happening;
 *   - the overlay never swallows touches — the bubble underneath stays tappable.
 *
 * The percentage text comes from the real ProgressRing and the byte text from the real @utils
 * formatters; neither is mocked, so this also pins the wiring between them.
 */
import React from 'react';
import { View } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { UploadProgressOverlay } from '@ui/attachments/UploadProgressOverlay';

const KB = 1024;
const MB = 1024 * 1024;

describe('UploadProgressOverlay', () => {
  it('shows the percentage and the byte readout once the total is known', async () => {
    await renderWithTheme(<UploadProgressOverlay sent={512 * KB} total={MB} />);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('512 KB of 1 MB')).toBeTruthy();
  });

  it('starts at "0 B of <total>" rather than a blank readout', async () => {
    // friendlySize renders 0 as an empty string, which would leave a dangling " of 1 MB".
    await renderWithTheme(<UploadProgressOverlay sent={0} total={MB} />);
    expect(screen.getByText('0 B of 1 MB')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('goes indeterminate (no percentage) while the total is unknown', async () => {
    // Every upload is briefly here: the native uploader only reports the content length on its
    // first progress event, and a voice memo is staged with no size at all.
    await renderWithTheme(<UploadProgressOverlay sent={512 * KB} total={0} />);
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.getByText('512 KB')).toBeTruthy();
  });

  it('compact keeps the ring but drops the byte readout', async () => {
    await renderWithTheme(<UploadProgressOverlay sent={512 * KB} total={MB} compact />);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.queryByText('512 KB of 1 MB')).toBeNull();
  });

  it('does not capture touches, so the bubble underneath stays tappable', async () => {
    await renderWithTheme(
      <View testID="host">
        <UploadProgressOverlay sent={1} total={2} />
      </View>,
    );
    const overlay = screen.getByTestId('host').children[0] as { props: Record<string, unknown> };
    expect(overlay.props.pointerEvents).toBe('none');
  });
});
