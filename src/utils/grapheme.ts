import { graphemeSegments } from 'unicode-segmenter/grapheme';

interface GraphemeSegment {
  readonly index: number;
  readonly segment: string;
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

/**
 * Return every safe UTF-16 boundary between user-visible characters.
 *
 * Android's Hermes runtime does not always ship `Intl.Segmenter`, so use the small Unicode
 * implementation as a deterministic fallback instead of disabling mentions and formatting.
 */
export function graphemeBoundaries(value: string): ReadonlySet<number> {
  const boundaries = new Set<number>([0, value.length]);
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;

  if (Segmenter) {
    try {
      for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
        boundaries.add(part.index);
        boundaries.add(part.index + part.segment.length);
      }
      return boundaries;
    } catch {
      // A partial runtime implementation is no safer than a missing one. Fall back below.
      boundaries.clear();
      boundaries.add(0);
      boundaries.add(value.length);
    }
  }

  for (const part of graphemeSegments(value)) {
    boundaries.add(part.index);
    boundaries.add(part.index + part.segment.length);
  }
  return boundaries;
}
