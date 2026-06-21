/** iMessage bubble (single-message) send effects. */
export type BubbleEffect = 'slam' | 'loud' | 'gentle' | 'invisibleInk';

/** iMessage full-screen send effects. */
export type ScreenEffect =
  | 'echo'
  | 'spotlight'
  | 'balloons'
  | 'confetti'
  | 'love'
  | 'lasers'
  | 'fireworks'
  | 'celebration';

/** Resolved effect for a message's expressiveSendStyleId. */
export type EffectDescriptor =
  | { kind: 'none' }
  | { kind: 'bubble'; name: BubbleEffect }
  | { kind: 'screen'; name: ScreenEffect };
