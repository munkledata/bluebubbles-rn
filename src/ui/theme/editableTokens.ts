import { type ThemeTokens } from './tokens';
import { contrastRatio } from './adaptiveFromImage';

/** One user-editable color in the theme editor (a labelled path into ThemeTokens.color). */
export interface EditableColorField {
  key: string;
  label: string;
  read: (t: ThemeTokens) => string;
  /** Mutates a tokens object in place (caller passes a clone). */
  write: (t: ThemeTokens, v: string) => void;
}

/** The colors a user can tweak — the rest of the token set (spacing/radii/font) is inherited. */
export const EDITABLE_COLORS: EditableColorField[] = [
  {
    key: 'tint',
    label: 'Tint / accent',
    read: (t) => t.color.tint,
    write: (t, v) => {
      t.color.tint = v;
    },
  },
  {
    key: 'background',
    label: 'Background',
    read: (t) => t.color.background,
    write: (t, v) => {
      t.color.background = v;
    },
  },
  {
    key: 'secondaryBackground',
    label: 'Secondary background',
    read: (t) => t.color.secondaryBackground,
    write: (t, v) => {
      t.color.secondaryBackground = v;
    },
  },
  {
    key: 'label',
    label: 'Text',
    read: (t) => t.color.label,
    write: (t, v) => {
      t.color.label = v;
    },
  },
  {
    key: 'secondaryLabel',
    label: 'Secondary text',
    read: (t) => t.color.secondaryLabel,
    write: (t, v) => {
      t.color.secondaryLabel = v;
    },
  },
  {
    key: 'separator',
    label: 'Separator',
    read: (t) => t.color.separator,
    write: (t, v) => {
      t.color.separator = v;
    },
  },
  {
    key: 'destructive',
    label: 'Destructive',
    read: (t) => t.color.destructive,
    write: (t, v) => {
      t.color.destructive = v;
    },
  },
  {
    key: 'senderBackground',
    label: 'Sent bubble',
    read: (t) => t.color.bubble.senderBackground,
    write: (t, v) => {
      t.color.bubble.senderBackground = v;
    },
  },
  {
    key: 'senderText',
    label: 'Sent bubble text',
    read: (t) => t.color.bubble.senderText,
    write: (t, v) => {
      t.color.bubble.senderText = v;
    },
  },
  {
    key: 'receivedBackgroundTop',
    label: 'Received bubble (top)',
    read: (t) => t.color.bubble.receivedBackgroundTop,
    write: (t, v) => {
      t.color.bubble.receivedBackgroundTop = v;
    },
  },
  {
    key: 'receivedBackgroundBottom',
    label: 'Received bubble (bottom)',
    read: (t) => t.color.bubble.receivedBackgroundBottom,
    write: (t, v) => {
      t.color.bubble.receivedBackgroundBottom = v;
    },
  },
  {
    key: 'receivedText',
    label: 'Received bubble text',
    read: (t) => t.color.bubble.receivedText,
    write: (t, v) => {
      t.color.bubble.receivedText = v;
    },
  },
  {
    key: 'smsBackground',
    label: 'SMS bubble (green)',
    read: (t) => t.color.bubble.smsBackground,
    write: (t, v) => {
      t.color.bubble.smsBackground = v;
    },
  },
  {
    key: 'rcsBackground',
    label: 'RCS bubble (green)',
    read: (t) => t.color.bubble.rcsBackground,
    write: (t, v) => {
      t.color.bubble.rcsBackground = v;
    },
  },
];

const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/** True for #RGB or #RRGGBB (case-insensitive). */
export function isValidHex(s: string): boolean {
  return HEX_RE.test(s.trim());
}

/** Deep clone so edits never mutate a shared preset object. */
export function cloneTokens(t: ThemeTokens): ThemeTokens {
  return JSON.parse(JSON.stringify(t)) as ThemeTokens;
}

export const MINIMUM_THEME_TEXT_CONTRAST = 4.5;

export interface ThemeContrastIssue {
  id: 'primary-text' | 'secondary-text' | 'action-text' | 'destructive-text' | 'received-text';
  label: string;
  foregroundKey: string;
  foreground: string;
  background: string;
  backgroundLabel: string;
  ratio: number;
  requiredRatio: number;
  suggestedForeground: string;
  suggestedRatio: number;
}

interface ContrastSurface {
  label: string;
  color: string;
}

interface ContrastRole {
  id: ThemeContrastIssue['id'];
  label: string;
  foregroundKey: string;
  foreground: string;
  surfaces: ContrastSurface[];
}

const SAFE_FOREGROUNDS = ['#111111', '#FFFFFF'] as const;

function worstContrast(
  foreground: string,
  surfaces: readonly ContrastSurface[],
): { background: ContrastSurface; ratio: number } {
  let worst = surfaces[0]!;
  let ratio = contrastRatio(foreground, worst.color);
  for (const surface of surfaces.slice(1)) {
    const nextRatio = contrastRatio(foreground, surface.color);
    if (nextRatio < ratio) {
      worst = surface;
      ratio = nextRatio;
    }
  }
  return { background: worst, ratio };
}

function safeForeground(surfaces: readonly ContrastSurface[]): {
  color: string;
  ratio: number;
} {
  const candidates = SAFE_FOREGROUNDS.map((color) => ({
    color,
    ratio: worstContrast(color, surfaces).ratio,
  }));
  return candidates[1]!.ratio > candidates[0]!.ratio ? candidates[1]! : candidates[0]!;
}

/**
 * Audit the normal-size text pairs a custom theme controls. A role may render on several surfaces;
 * it passes only when the same foreground clears WCAG AA on every one of them.
 *
 * Sent iMessage/SMS/RCS text is deliberately absent: those bubbles choose `readableTextOn` from
 * their rendered background at runtime, so user-edited bubble fills cannot make their text fail.
 */
export function auditThemeContrast(tokens: ThemeTokens): ThemeContrastIssue[] {
  const c = tokens.color;
  const appSurfaces: ContrastSurface[] = [
    { label: 'main background', color: c.background },
    { label: 'secondary background', color: c.secondaryBackground },
    { label: 'grouped background', color: c.groupedBackground },
  ];
  const roles: ContrastRole[] = [
    {
      id: 'primary-text',
      label: 'Primary text',
      foregroundKey: 'label',
      foreground: c.label,
      surfaces: appSurfaces,
    },
    {
      id: 'secondary-text',
      label: 'Secondary text',
      foregroundKey: 'secondaryLabel',
      foreground: c.secondaryLabel,
      surfaces: appSurfaces,
    },
    {
      id: 'action-text',
      label: 'Tint / action text',
      foregroundKey: 'tint',
      foreground: c.tint,
      surfaces: appSurfaces,
    },
    {
      id: 'destructive-text',
      label: 'Destructive action text',
      foregroundKey: 'destructive',
      foreground: c.destructive,
      surfaces: appSurfaces,
    },
    {
      id: 'received-text',
      label: 'Received message text',
      foregroundKey: 'receivedText',
      foreground: c.bubble.receivedText,
      surfaces: [
        { label: 'received bubble top', color: c.bubble.receivedBackgroundTop },
        { label: 'received bubble bottom', color: c.bubble.receivedBackgroundBottom },
      ],
    },
  ];

  return roles.flatMap((role) => {
    const current = worstContrast(role.foreground, role.surfaces);
    if (current.ratio >= MINIMUM_THEME_TEXT_CONTRAST) return [];
    const suggested = safeForeground(role.surfaces);
    return [
      {
        id: role.id,
        label: role.label,
        foregroundKey: role.foregroundKey,
        foreground: role.foreground,
        background: current.background.color,
        backgroundLabel: current.background.label,
        ratio: current.ratio,
        requiredRatio: MINIMUM_THEME_TEXT_CONTRAST,
        suggestedForeground: suggested.color,
        suggestedRatio: suggested.ratio,
      },
    ];
  });
}

/** Return a cloned token set with each failing foreground replaced by its safest neutral color. */
export function fixThemeContrast(
  tokens: ThemeTokens,
  issues: readonly ThemeContrastIssue[] = auditThemeContrast(tokens),
): ThemeTokens {
  const fixed = cloneTokens(tokens);
  for (const issue of issues) {
    EDITABLE_COLORS.find((field) => field.key === issue.foregroundKey)?.write(
      fixed,
      issue.suggestedForeground,
    );
  }
  return fixed;
}
