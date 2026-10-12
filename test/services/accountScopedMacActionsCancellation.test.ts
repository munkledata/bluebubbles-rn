/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * Review item 1073: every account-scoped Mac action that holds a Disconnect drain slot hands its
 * request the lease-bound client, so Disconnect cancels the request instead of waiting out its
 * 30 s timeout. The services behind the actions are mocked; this pins only that wiring.
 */
const mockSharedHttp = { __shared: true };
const mockBoundHttp = { __bound: true };
const mockAccountHttp = jest.fn((_lease: unknown) => mockBoundHttp);
const mockService = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: 'ok' }));

jest.mock('@/services/clients', () => ({
  get http() {
    return mockSharedHttp;
  },
  accountHttp: (lease: unknown) => mockAccountHttp(lease),
}));
jest.mock('@db/database', () => ({ getDatabase: () => ({ __db: true }) }));
jest.mock('@/services/send/rcsAttemptCapability', () => ({
  captureSessionRcsCapabilityLease: () => ({
    serverInfo: {
      supports_imessage_group_rename: true,
      supports_imessage_group_participant_add: true,
      supports_imessage_group_participant_remove: true,
      supports_imessage_group_leave: true,
      supports_imessage_remote_delete: true,
      supports_facetime_call_start: true,
      supports_facetime_link_creation: true,
      supports_imessage_group_photo: true,
    },
    isCurrent: () => true,
  }),
}));
jest.mock('@/services/groupRenameService', () => ({
  renameExactIMessageGroup: (...args: unknown[]) => mockService(...args),
}));
jest.mock('@/services/groupParticipantService', () => ({
  addExactIMessageGroupParticipant: (...args: unknown[]) => mockService(...args),
  removeExactIMessageGroupParticipant: (...args: unknown[]) => mockService(...args),
  leaveExactIMessageGroup: (...args: unknown[]) => mockService(...args),
}));
jest.mock('@/services/remoteMessageDeleteService', () => ({
  remoteDeleteExactIMessage: (...args: unknown[]) => mockService(...args),
}));
jest.mock('@/services/facetimeCallService', () => ({
  startExactFaceTimeCall: (...args: unknown[]) => mockService(...args),
}));
jest.mock('@/services/facetimeLinkService', () => ({
  createExactFaceTimeLink: (...args: unknown[]) => mockService(...args),
}));
jest.mock('@/services/groupPhotoService', () => ({
  prepareExactIMessageGroupPhotoSet: (...args: unknown[]) => mockService(...args),
  removeExactIMessageGroupPhoto: (...args: unknown[]) => mockService(...args),
}));

import { createAppleFaceTimeLink } from '@/services/facetimeLinkUiService';
import { startAppleFaceTimeCall } from '@/services/facetimeCallUiService';
import {
  addAppleGroupParticipant,
  leaveAppleGroup,
  removeAppleGroupParticipant,
} from '@/services/groupParticipantUiService';
import { prepareAppleGroupPhotoSet, removeAppleGroupPhoto } from '@/services/groupPhotoUiService';
import { renameAppleGroup } from '@/services/groupRenameUiService';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { deleteMessageFromMac } from '@/services/remoteMessageDeleteUiService';

const actions: Array<[string, (lease: RealtimeDeliveryLease) => Promise<unknown>]> = [
  ['rename a group', (lease) => renameAppleGroup({} as never, lease)],
  ['add a group participant', (lease) => addAppleGroupParticipant({} as never, lease)],
  ['remove a group participant', (lease) => removeAppleGroupParticipant({} as never, lease)],
  ['leave a group', (lease) => leaveAppleGroup({} as never, lease)],
  ['delete a message from the Mac', (lease) => deleteMessageFromMac({} as never, lease)],
  ['start a FaceTime call', (lease) => startAppleFaceTimeCall({} as never, lease)],
  ['create a FaceTime link', (lease) => createAppleFaceTimeLink(lease)],
  ['prepare a group photo', (lease) => prepareAppleGroupPhotoSet('iMessage;+;chat1', lease)],
  ['remove a group photo', (lease) => removeAppleGroupPhoto({} as never, lease)],
];

describe('account-scoped Mac actions use the Disconnect-cancellable client', () => {
  beforeEach(() => {
    mockAccountHttp.mockClear();
    mockService.mockClear();
  });
  afterEach(() => {
    resumeRealtimeDeliveries();
  });

  it.each(actions)('%s', async (_name, run) => {
    const lease = captureRealtimeDeliveryLease();
    await run(lease);

    expect(mockService).toHaveBeenCalledTimes(1);
    expect(mockService.mock.calls[0]).toContain(mockBoundHttp);
    expect(mockService.mock.calls[0]).not.toContain(mockSharedHttp);
    expect(mockAccountHttp).toHaveBeenCalledWith(lease);
  });
});
