import type { SmartReplyMessage, SmartReplyProvider } from './types';

/**
 * Rule-based suggestions from the latest inbound message. Pure + Node-testable.
 * This is the default provider; a real on-device ML Kit Smart Reply provider can
 * replace it behind `SmartReplyProvider` (no maintained Expo-compatible native
 * module exists today, so the rule engine ships as v1).
 */
export function suggestForText(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];
  const t = raw.toLowerCase();
  let out: string[];
  if (/\?\s*$/.test(raw)) out = ['Yes', 'No', 'Maybe'];
  else if (/\b(thanks|thank you|thx|ty|appreciate)\b/.test(t))
    out = ["You're welcome!", 'No problem', '👍'];
  else if (/\b(love you|miss you|love u|miss u)\b/.test(t))
    out = ['❤️', 'Love you too', 'Miss you too'];
  else if (/\b(hi|hey|hello|yo|sup|howdy)\b/.test(t)) out = ['Hey!', 'Hello!', 'What’s up?'];
  else if (/\b(sorry|my bad|apologies)\b/.test(t)) out = ['No worries', 'It’s okay', 'All good'];
  else if (/\b(congrats|congratulations|nice job|well done)\b/.test(t))
    out = ['Thank you!', '🎉', 'Appreciate it'];
  else if (/\b(ok|okay|sounds good|cool|got it|great|perfect)\b/.test(t))
    out = ['👍', 'Sounds good', 'Perfect'];
  else out = ['Sounds good', 'Thanks!', 'Got it'];
  return [...new Set(out)].slice(0, 3);
}

export const ruleSmartReplyProvider: SmartReplyProvider = {
  async suggest(history: SmartReplyMessage[]): Promise<string[]> {
    // Suggest only when the OTHER person sent the most recent message (history is
    // oldest→newest) — don't suggest a reply if you already responded.
    const last = history[history.length - 1];
    if (!last || last.isFromMe || !last.text.trim()) return [];
    return suggestForText(last.text);
  },
};
