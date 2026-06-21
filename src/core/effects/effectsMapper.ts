import type { BubbleEffect, EffectDescriptor, ScreenEffect } from './types';

// Exact iMessage expressiveSendStyleId → effect (from Flutter constants.dart effectMap).
const BUBBLE_IDS: Record<string, BubbleEffect> = {
  'com.apple.MobileSMS.expressivesend.impact': 'slam',
  'com.apple.MobileSMS.expressivesend.loud': 'loud',
  'com.apple.MobileSMS.expressivesend.gentle': 'gentle',
  'com.apple.MobileSMS.expressivesend.invisibleink': 'invisibleInk',
};

const SCREEN_IDS: Record<string, ScreenEffect> = {
  'com.apple.messages.effect.CKEchoEffect': 'echo',
  'com.apple.messages.effect.CKSpotlightEffect': 'spotlight',
  'com.apple.messages.effect.CKHappyBirthdayEffect': 'balloons',
  'com.apple.messages.effect.CKConfettiEffect': 'confetti',
  'com.apple.messages.effect.CKHeartEffect': 'love',
  'com.apple.messages.effect.CKLasersEffect': 'lasers',
  'com.apple.messages.effect.CKFireworksEffect': 'fireworks',
  'com.apple.messages.effect.CKSparklesEffect': 'celebration',
};

/** Map a message's expressiveSendStyleId to its effect (or none for unknown/null). */
export function mapExpressiveSendStyleId(id: string | null | undefined): EffectDescriptor {
  if (!id) return { kind: 'none' };
  const bubble = BUBBLE_IDS[id];
  if (bubble) return { kind: 'bubble', name: bubble };
  const screen = SCREEN_IDS[id];
  if (screen) return { kind: 'screen', name: screen };
  return { kind: 'none' };
}

export function bubbleEffectOf(id: string | null | undefined): BubbleEffect | null {
  const d = mapExpressiveSendStyleId(id);
  return d.kind === 'bubble' ? d.name : null;
}

export function screenEffectOf(id: string | null | undefined): ScreenEffect | null {
  const d = mapExpressiveSendStyleId(id);
  return d.kind === 'screen' ? d.name : null;
}

/** A sendable effect (id + display label) for the composer's effect picker. */
export interface EffectOption {
  id: string;
  label: string;
  kind: 'bubble' | 'screen';
}

export const EFFECT_OPTIONS: EffectOption[] = [
  { id: 'com.apple.MobileSMS.expressivesend.impact', label: 'Slam', kind: 'bubble' },
  { id: 'com.apple.MobileSMS.expressivesend.loud', label: 'Loud', kind: 'bubble' },
  { id: 'com.apple.MobileSMS.expressivesend.gentle', label: 'Gentle', kind: 'bubble' },
  { id: 'com.apple.MobileSMS.expressivesend.invisibleink', label: 'Invisible Ink', kind: 'bubble' },
  { id: 'com.apple.messages.effect.CKConfettiEffect', label: 'Confetti', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKHappyBirthdayEffect', label: 'Balloons', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKFireworksEffect', label: 'Fireworks', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKHeartEffect', label: 'Love', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKLasersEffect', label: 'Lasers', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKSparklesEffect', label: 'Celebration', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKEchoEffect', label: 'Echo', kind: 'screen' },
  { id: 'com.apple.messages.effect.CKSpotlightEffect', label: 'Spotlight', kind: 'screen' },
];
