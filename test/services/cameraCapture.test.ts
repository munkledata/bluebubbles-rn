/**
 * The camera record (kv camera.captureChat) names the chat whose composer opened the system camera.
 * It is written through one lease-fenced transaction owner, and a retired account writes or reads
 * nothing.
 */
import type Database from 'better-sqlite3';
import { kvGet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  CAMERA_CAPTURE_CHAT_KV_KEY,
  loadCameraCaptureChat,
  saveCameraCaptureChat,
} from '@/services/cameraCapture';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;

jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => mockDb) }));

const CHAT = 'any;-;+15551234567';

describe('camera capture record', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    raw.close();
  });

  it('records the chat, reads it back, and clears it with an empty value', async () => {
    const lease = captureRealtimeDeliveryLease();
    await saveCameraCaptureChat(CHAT, lease);
    await expect(kvGet(mockDb, CAMERA_CAPTURE_CHAT_KV_KEY)).resolves.toBe(CHAT);
    await expect(loadCameraCaptureChat(lease)).resolves.toBe(CHAT);

    await saveCameraCaptureChat('', lease);
    await expect(loadCameraCaptureChat(lease)).resolves.toBeNull();
  });

  it('writes and reads nothing for an account retired before the call', async () => {
    const retired = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await saveCameraCaptureChat(CHAT, retired);
    await expect(kvGet(mockDb, CAMERA_CAPTURE_CHAT_KV_KEY)).resolves.toBeNull();

    await saveCameraCaptureChat(CHAT, captureRealtimeDeliveryLease());
    await expect(loadCameraCaptureChat(retired)).resolves.toBeNull();
  });
});
