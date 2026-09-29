/** One styled span of a message body parsed from its attributedBody. */
export interface TextRun {
  text: string;
  /** A confirmed @mention (render with the accent color). */
  mention?: boolean;
  /** An inline attachment placeholder (rendered separately, skipped in text). */
  attachment?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}
