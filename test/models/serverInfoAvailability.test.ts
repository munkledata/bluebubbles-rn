import { ServerInfo } from '@core/models';

// The availability endpoint wrapper was never called by the app and was removed (Phase 6); these
// keep the capability flags it depended on honest.
describe('read-only iMessage availability capability', () => {
  it('preserves the narrow new-chat capability while broad Private API stays retired', () => {
    const info = ServerInfo.parse({
      version: 'test',
      private_api: true,
      supports_imessage_new_chat: true,
    });
    expect(info.private_api).toBe(false);
    expect(info.supports_imessage_new_chat).toBe(true);
  });
  it.each([true, false])(
    'preserves supports_imessage_availability=%s without restoring retired capabilities',
    (supported) => {
      const info = ServerInfo.parse({
        version: '2.0.0',
        supports_imessage_availability: supported,
        private_api: true,
        supports_imessage_text_with_attachment: true,
        supports_icloud_account: true,
      });

      expect(info.supports_imessage_availability).toBe(supported);
      expect(info.private_api).toBe(false);
      expect(info.supports_imessage_text_with_attachment).toBe(false);
      expect(info.supports_icloud_account).toBe(false);
    },
  );

  it('keeps an absent availability capability absent', () => {
    const info = ServerInfo.parse({ version: '1.9.0' });

    expect(info.supports_imessage_availability).toBeUndefined();
    expect(info.private_api).toBe(false);
    expect(info.supports_imessage_text_with_attachment).toBe(false);
    expect(info.supports_icloud_account).toBe(false);
  });
});
