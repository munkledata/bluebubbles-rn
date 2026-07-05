import { type ThemeTokens } from './tokens';

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
    label: 'RCS bubble (teal)',
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
