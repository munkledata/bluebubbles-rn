import { sendLocation } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { getChatHeader, insertOutgoingLocationWithinTransaction } from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenOneToOneIMessageChat, isRcsChatGuid } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import {
  handleSendFailure,
  isTerminalLocationSendError,
  reconcileSendOutcome,
} from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

export interface CurrentLocationCoordinates {
  latitude: number;
  longitude: number;
}

function validateCoordinates(coordinates: CurrentLocationCoordinates): void {
  if (
    !Number.isFinite(coordinates.latitude) ||
    coordinates.latitude < -90 ||
    coordinates.latitude > 90
  ) {
    throw new RangeError('latitude must be finite and between -90 and 90');
  }
  if (
    !Number.isFinite(coordinates.longitude) ||
    coordinates.longitude < -180 ||
    coordinates.longitude > 180
  ) {
    throw new RangeError('longitude must be finite and between -180 and 180');
  }
}

/**
 * Queue and send one foreground-acquired current location. The original temp GUID is the server's
 * durable idempotency key, so ordinary transport and temporary-service failures remain retryable.
 */
export async function sendCurrentLocationMessage(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; coordinates: CurrentLocationCoordinates },
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
  onQueued?: (tempGuid: string) => void | Promise<void>,
): Promise<{ tempGuid: string }> {
  if (isRcsChatGuid(args.chatGuid)) {
    throw new Error('Current location sharing is available only in iMessage conversations.');
  }
  validateCoordinates(args.coordinates);
  const transport = pinSendTransport(http, commitGuard);
  const tempGuid = generateTempGuid();
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    args.chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: true },
  );
  const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
  if (capability.serverInfo?.supports_imessage_location !== true) {
    throw new Error('This server cannot send a current location.');
  }
  const header = await getChatHeader(db, args.chatGuid);
  if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
  if (!isProvenOneToOneIMessageChat(header)) {
    throw new Error('A proven existing one-to-one iMessage chat is required.');
  }

  await withDbTransaction(
    db,
    (context) =>
      insertOutgoingLocationWithinTransaction(context, {
        tempGuid,
        chatGuid: args.chatGuid,
        latitude: args.coordinates.latitude,
        longitude: args.coordinates.longitude,
        now,
      }),
    capabilityGuard,
  );
  await onQueued?.(tempGuid);
  if (!capabilityGuard()) throw new DbCommitGuardRejectedError();

  try {
    transport.assertNetworkCurrent();
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    const server = await sendLocation(transport.http, {
      chatGuid: args.chatGuid,
      tempGuid,
      latitude: args.coordinates.latitude,
      longitude: args.coordinates.longitude,
    });
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard, {
      expectedChatGuid: args.chatGuid,
    });
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) throw error;
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    await handleSendFailure(
      db,
      tempGuid,
      error,
      'send-location',
      args.chatGuid,
      undefined,
      commitGuard,
      isTerminalLocationSendError(error) ? { terminalUncertainKind: 'location' } : undefined,
    );
  }

  return { tempGuid };
}
