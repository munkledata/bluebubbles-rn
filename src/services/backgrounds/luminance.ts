import { logger } from '@core/secure';
import { relativeLuminance } from '@ui/theme';

/** Above this WCAG relative luminance the wallpaper counts as "light" → dark overlay text. */
const LIGHT_THRESHOLD = 0.55;

/**
 * Whether a chat wallpaper reads as LIGHT (→ dark overlay text) or DARK (→ light overlay text),
 * from its average/dominant colour. Reuses `react-native-image-colors` (as the adaptive-theme path
 * does) + `relativeLuminance`. Returns `null` on ANY failure (module not linked, decode error) so
 * the render falls back to the theme-mode scrim instead of crashing. Computed once when the
 * wallpaper is set — not per render.
 */
export async function computeBackgroundIsLight(uri: string): Promise<boolean | null> {
  try {
    const ImageColors = (await import('react-native-image-colors')).default;
    const result = await ImageColors.getColors(uri, { cache: true, key: uri });
    let base: string | undefined;
    switch (result.platform) {
      case 'android':
        base = result.average || result.dominant;
        break;
      case 'ios':
        base = result.background || result.primary;
        break;
      default:
        base = (result as { dominant?: string }).dominant;
        break;
    }
    if (!base) return null;
    return relativeLuminance(base) > LIGHT_THRESHOLD;
  } catch (e) {
    logger.debug('[background] luminance compute skipped', e);
    return null;
  }
}
