import type { EventDeliveryContext, EventOccurrenceMetadata } from '@core/realtime';
import { DevPushTransport } from '@core/realtime/pushTransport';

describe('DevPushTransport', () => {
  it('forwards account and occurrence metadata with an injected event', async () => {
    const transport = new DevPushTransport();
    const dispatch = jest.fn(async () => undefined);
    const context: EventDeliveryContext = { generation: 7, isCurrent: () => true };
    const occurrence: EventOccurrenceMetadata = {
      transportOccurrenceId: 'dev:message-1',
    };
    transport.start(dispatch);

    await transport.inject('new-message', { guid: 'message-1' }, context, occurrence);

    expect(dispatch).toHaveBeenCalledWith(
      'new-message',
      { guid: 'message-1' },
      context,
      occurrence,
    );
  });

  it('stops forwarding after the transport is stopped', async () => {
    const transport = new DevPushTransport();
    const dispatch = jest.fn(async () => undefined);
    transport.start(dispatch);
    transport.stop();

    await transport.inject('new-message', { guid: 'message-1' });

    expect(dispatch).not.toHaveBeenCalled();
  });
});
