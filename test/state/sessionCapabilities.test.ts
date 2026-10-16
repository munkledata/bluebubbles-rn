import { ServerInfo } from '@core/models';
import { captureSessionRcsCapabilityLease } from '@/services/send/rcsAttemptCapability';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';

describe('sessionAccessors.imessageReadStateEnabled', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('is true only for the explicit narrow read-state capability', () => {
    expect(sessionAccessors.imessageReadStateEnabled()).toBe(false);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', private_api: true }),
    });
    expect(sessionAccessors.imessageReadStateEnabled()).toBe(false);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: '1.9.0',
        supports_imessage_read_state: true,
      }),
    });
    expect(sessionAccessors.imessageReadStateEnabled()).toBe(true);
  });
});

describe('session transport-scoped server info', () => {
  it('rejects an A -> B -> A stale result, accepts the current revision, and clears info on hydration', () => {
    const originalInfo = ServerInfo.parse({ version: '1.0.0' });
    const rotatedInfo = ServerInfo.parse({ version: '2.0.0' });
    const returnedInfo = ServerInfo.parse({ version: '3.0.0' });
    const staleInfo = ServerInfo.parse({ version: 'stale' });
    const currentInfo = ServerInfo.parse({ version: 'current' });

    useSessionStore.getState().connected('https://a.example', 'password', originalInfo);
    const staleRevision = useSessionStore.getState().transportRevision;

    useSessionStore.getState().rotateOrigin('https://b.example', rotatedInfo);
    useSessionStore.getState().rotateOrigin('https://a.example', returnedInfo);
    const currentRevision = useSessionStore.getState().transportRevision;

    expect(
      useSessionStore
        .getState()
        .setServerInfoForTransport('https://a.example', staleRevision, staleInfo),
    ).toBe(false);
    expect(useSessionStore.getState().serverInfo).toBe(returnedInfo);

    expect(
      useSessionStore
        .getState()
        .setServerInfoForTransport('https://a.example', currentRevision, currentInfo),
    ).toBe(true);
    expect(useSessionStore.getState().serverInfo).toBe(currentInfo);

    useSessionStore.getState().hydrated({ origin: 'https://a.example', password: 'password' });
    expect(useSessionStore.getState().serverInfo).toBeNull();
  });
});

describe('session send-capability leases', () => {
  const uploadAdvertised = (): boolean =>
    useSessionStore.getState().serverInfo?.supports_imessage_attachment_upload === true;

  it('invalidates an in-flight send when the narrow iMessage upload flag turns off', () => {
    const previousSession = useSessionStore.getState();
    const enabled = ServerInfo.parse({
      version: '2.0.15-bbd',
      private_api: true,
      supports_imessage_attachment_upload: true,
    });
    const disabled = ServerInfo.parse({ version: '2.0.15-bbd' });
    try {
      useSessionStore.getState().connected('https://same-transport.test', 'password', enabled);
      expect(uploadAdvertised()).toBe(true);
      expect(useSessionStore.getState().serverInfo?.private_api).toBe(false);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected connected capability lease');
      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, disabled),
      ).toBe(true);
      expect(lease.isCurrent()).toBe(false);
      expect(uploadAdvertised()).toBe(false);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('invalidates an in-flight PDF send when PDF support turns off but image support remains', () => {
    const previousSession = useSessionStore.getState();
    const enabled = ServerInfo.parse({
      version: '2.0.15-bbd',
      supports_imessage_attachment_upload: true,
      supports_imessage_pdf_attachment_upload: true,
    });
    const imageOnly = ServerInfo.parse({
      version: '2.0.15-bbd',
      supports_imessage_attachment_upload: true,
    });
    try {
      useSessionStore.getState().connected('https://same-transport.test', 'password', enabled);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected connected capability lease');
      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, imageOnly),
      ).toBe(true);
      expect(lease.isCurrent()).toBe(false);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('invalidates an in-flight caption send when narrow caption support turns off', () => {
    const previousSession = useSessionStore.getState();
    const enabled = ServerInfo.parse({
      version: '2.0.15-bbd',
      supports_imessage_attachment_upload: true,
      supports_imessage_attachment_caption_upload: true,
      supports_imessage_text_with_attachment: true,
    });
    const attachmentOnly = ServerInfo.parse({
      version: '2.0.15-bbd',
      supports_imessage_attachment_upload: true,
    });
    try {
      expect(enabled.supports_imessage_text_with_attachment).toBe(false);
      useSessionStore.getState().connected('https://same-transport.test', 'password', enabled);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected connected capability lease');
      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, attachmentOnly),
      ).toBe(true);
      expect(lease.isCurrent()).toBe(false);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('parses the narrow plain-text capability and invalidates its captured send lease', () => {
    const previousSession = useSessionStore.getState();
    const enabled = ServerInfo.parse({
      version: '2.0.15-bbd',
      supports_imessage_plain_text: true,
    });
    const disabled = ServerInfo.parse({ version: '2.0.15-bbd' });
    try {
      expect(enabled.supports_imessage_plain_text).toBe(true);
      useSessionStore.getState().connected('https://same-transport.test', 'password', enabled);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected connected capability lease');
      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, disabled),
      ).toBe(true);
      expect(lease.isCurrent()).toBe(false);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('keeps a lease current when refreshed server info has identical send capabilities', () => {
    const previousSession = useSessionStore.getState();
    const originalInfo = ServerInfo.parse({
      version: '2.0.0',
      rcs: true,
      supports_message_deleted: false,
    });
    const refreshedInfo = ServerInfo.parse({
      version: '2.0.1',
      rcs: true,
      supports_message_deleted: true,
    });

    try {
      useSessionStore.getState().connected('https://same-transport.test', 'password', originalInfo);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected a connected capability lease');
      const capabilityRevision = useSessionStore.getState().sendCapabilityRevision;

      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, refreshedInfo),
      ).toBe(true);
      expect(useSessionStore.getState().sendCapabilityRevision).toBe(capabilityRevision);
      expect(useSessionStore.getState().serverInfo).toBe(refreshedInfo);
      expect(lease.isCurrent()).toBe(true);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('does not revive an old lease when RCS changes true to false and back on one transport', () => {
    const previousSession = useSessionStore.getState();
    const rcsEnabled = ServerInfo.parse({ version: '2.0.0', rcs: true });
    const rcsDisabled = ServerInfo.parse({ version: '2.0.0', rcs: false });

    try {
      useSessionStore.getState().connected('https://same-transport.test', 'password', rcsEnabled);
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected a connected capability lease');
      const transportRevision = useSessionStore.getState().transportRevision;

      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, rcsDisabled),
      ).toBe(true);
      expect(useSessionStore.getState().transportRevision).toBe(transportRevision);
      expect(lease.isCurrent()).toBe(false);

      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, rcsEnabled),
      ).toBe(true);
      expect(useSessionStore.getState().transportRevision).toBe(transportRevision);
      expect(lease.isCurrent()).toBe(false);

      const currentLease = captureSessionRcsCapabilityLease();
      expect(currentLease?.isCurrent()).toBe(true);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('updates a null-info lease when it publishes discovered server info', () => {
    const previousSession = useSessionStore.getState();
    const discoveredInfo = ServerInfo.parse({
      version: '2.0.0',
      rcs: true,
      supports_rcs_send_attempt_ownership: true,
    });

    try {
      useSessionStore
        .getState()
        .hydrated({ origin: 'https://capability-discovery.test', password: 'password' });
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected a connected capability lease');

      expect(lease.serverInfo).toBeNull();
      expect(lease.isCurrent()).toBe(true);
      expect(lease.publish(discoveredInfo)).toBe(true);
      expect(lease.serverInfo).toBe(discoveredInfo);
      expect(useSessionStore.getState().serverInfo).toBe(discoveredInfo);
      expect(lease.isCurrent()).toBe(true);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });
});
