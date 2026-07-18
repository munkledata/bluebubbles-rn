import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { create as createQr } from 'qrcode';

/**
 * Pure-JS QR code renderer — no native module, no SVG, no WebView.
 *
 * `qrcode`'s `create()` builds the module matrix in plain JS; we paint it as
 * nested Views (one row View per matrix row, one segment View per run of
 * same-colored modules — run-length merging keeps the View count low). Always
 * dark-on-white regardless of theme: scanners need the contrast, so the code
 * sits on its own white card.
 */
export interface QrCodeProps {
  /** The exact string a scanner should read back. */
  value: string;
  /** Finished edge length in dp (quiet zone included). Default 240. */
  size?: number;
  testID?: string;
}

/** One run of consecutive same-colored modules within a row. */
interface Run {
  dark: boolean;
  length: number;
}

/** Run-length encode each matrix row so a 33×33 code is ~200 Views, not ~1100. */
function toRows(data: Uint8Array, moduleCount: number): Run[][] {
  const rows: Run[][] = [];
  for (let r = 0; r < moduleCount; r++) {
    const runs: Run[] = [];
    for (let c = 0; c < moduleCount; c++) {
      const dark = data[r * moduleCount + c] === 1;
      const last = runs[runs.length - 1];
      if (last && last.dark === dark) last.length += 1;
      else runs.push({ dark, length: 1 });
    }
    rows.push(runs);
  }
  return rows;
}

export function QrCode({ value, size = 240, testID }: QrCodeProps): React.JSX.Element | null {
  const matrix = useMemo(() => {
    try {
      const { modules } = createQr(value, { errorCorrectionLevel: 'M' });
      return { rows: toRows(modules.data, modules.size), count: modules.size };
    } catch {
      return null; // empty/oversized value — nothing sensible to render
    }
  }, [value]);

  if (!matrix) return null;

  // Integer cell size avoids sub-pixel seams between modules; the standard quiet
  // zone is 4 modules of white on every side.
  const cell = Math.max(1, Math.floor(size / (matrix.count + 8)));
  const quiet = cell * 4;

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel="QR code"
      style={[styles.card, { padding: quiet }]}
    >
      {matrix.rows.map((runs, r) => (
        <View key={r} style={[styles.row, { height: cell }]}>
          {runs.map((run, i) => (
            <View
              key={i}
              style={{
                width: run.length * cell,
                height: cell,
                backgroundColor: run.dark ? '#000000' : '#FFFFFF',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, alignSelf: 'center' },
  row: { flexDirection: 'row' },
});
