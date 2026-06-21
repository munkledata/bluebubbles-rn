import { bubbleEffectOf, mapExpressiveSendStyleId, screenEffectOf } from '@core/effects';

describe('mapExpressiveSendStyleId', () => {
  it('maps the four bubble effects', () => {
    expect(mapExpressiveSendStyleId('com.apple.MobileSMS.expressivesend.impact')).toEqual({
      kind: 'bubble',
      name: 'slam',
    });
    expect(bubbleEffectOf('com.apple.MobileSMS.expressivesend.loud')).toBe('loud');
    expect(bubbleEffectOf('com.apple.MobileSMS.expressivesend.gentle')).toBe('gentle');
    expect(bubbleEffectOf('com.apple.MobileSMS.expressivesend.invisibleink')).toBe('invisibleInk');
  });

  it('maps the eight screen effects', () => {
    expect(screenEffectOf('com.apple.messages.effect.CKEchoEffect')).toBe('echo');
    expect(screenEffectOf('com.apple.messages.effect.CKSpotlightEffect')).toBe('spotlight');
    expect(screenEffectOf('com.apple.messages.effect.CKHappyBirthdayEffect')).toBe('balloons');
    expect(screenEffectOf('com.apple.messages.effect.CKConfettiEffect')).toBe('confetti');
    expect(screenEffectOf('com.apple.messages.effect.CKHeartEffect')).toBe('love');
    expect(screenEffectOf('com.apple.messages.effect.CKLasersEffect')).toBe('lasers');
    expect(screenEffectOf('com.apple.messages.effect.CKFireworksEffect')).toBe('fireworks');
    expect(screenEffectOf('com.apple.messages.effect.CKSparklesEffect')).toBe('celebration');
  });

  it('returns none for null/unknown ids', () => {
    expect(mapExpressiveSendStyleId(null)).toEqual({ kind: 'none' });
    expect(mapExpressiveSendStyleId(undefined)).toEqual({ kind: 'none' });
    expect(mapExpressiveSendStyleId('com.apple.unknown.effect')).toEqual({ kind: 'none' });
    expect(bubbleEffectOf('com.apple.messages.effect.CKConfettiEffect')).toBeNull(); // screen ≠ bubble
    expect(screenEffectOf('com.apple.MobileSMS.expressivesend.impact')).toBeNull();
  });
});
