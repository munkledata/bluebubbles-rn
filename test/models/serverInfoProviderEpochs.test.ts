import { ServerInfo } from '@core/models';
import { currentRcsProviderEpoch } from '@core/rcs';

// One malformed pairing id must not reject the whole /server/info reply: that blocked connecting.
// Consumers already treat a missing id as "no current pairing".
describe('ServerInfo pairing ids', () => {
  const RCS_EPOCH = `gpe1_${'A'.repeat(43)}`;
  const IMESSAGE_EPOCH = '123e4567-e89b-42d3-a456-426614174000';

  it('reads a malformed RCS pairing id as no current pairing', () => {
    const info = ServerInfo.parse({
      version: '2.0.0',
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: 'not-a-pairing-id',
    });

    expect(info.rcs_provider_epoch).toBeNull();
    expect(currentRcsProviderEpoch(info)).toBeNull();
    expect(info.rcs).toBe(true);
  });

  it('reads a malformed iMessage pairing id as no message-state identity', () => {
    const info = ServerInfo.parse({
      version: '2.0.0',
      supports_message_state_sync: true,
      imessage_provider_epoch: 'not-a-uuid',
    });

    expect(info.imessage_provider_epoch).toBeNull();
    expect(info.supports_message_state_sync).toBe(true);
  });

  it('keeps valid and absent pairing ids as sent', () => {
    expect(
      ServerInfo.parse({
        version: '2.0.0',
        rcs_provider_epoch: RCS_EPOCH,
        imessage_provider_epoch: IMESSAGE_EPOCH,
      }),
    ).toEqual(
      expect.objectContaining({
        rcs_provider_epoch: RCS_EPOCH,
        imessage_provider_epoch: IMESSAGE_EPOCH,
      }),
    );
    const absent = ServerInfo.parse({ version: '2.0.0' });
    expect(absent.rcs_provider_epoch).toBeUndefined();
    expect(absent.imessage_provider_epoch).toBeUndefined();
  });
});
