/* eslint-disable import/first -- Jest mocks must exist before importing the production adapter. */
jest.mock('expo-file-system', () => {
  const Directory = jest.fn(function (this: { uri: string }, ...parts: string[]) {
    this.uri = parts.join('/');
  });
  const File = jest.fn(function (this: { uri: string }, directory: { uri: string }, name: string) {
    this.uri = `${directory.uri}/${name}`;
  });
  return { Directory, File, Paths: { document: 'file:///documents' } };
});

import { adoptNativePastedAttachment } from '@native/boundedDownload';
import type { AppDatabase } from '@db/types';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheReservation,
  type AttachmentCacheReservationScope,
} from '@/services/download/attachmentCacheCoordinator';
import { createOutgoingPasteOwnershipPreparer } from '@/services/send/outgoingPasteOwnership';

const db = {} as AppDatabase;
const source = {
  uri: 'file:///cache/pasted-in/1000-1/photo.jpg',
  name: 'photo one.jpg',
  mimeType: 'image/jpeg',
  size: 42,
  origin: 'paste' as const,
};

function scope(isCurrent: () => boolean = () => true): AttachmentCacheReservationScope {
  return {
    generation: 7,
    isCurrent,
    runTracked: async (task) => task(),
  };
}

function reservation(path: string): AttachmentCacheReservation & { release: jest.Mock } {
  return {
    path,
    maxBytes: 42,
    generation: 7,
    beginProtectionHandoff: () => true,
    rollbackProtectionHandoff: () => true,
    release: jest.fn(async () => undefined),
  };
}

const adopt = adoptNativePastedAttachment as jest.MockedFunction<
  typeof adoptNativePastedAttachment
>;

afterEach(() => {
  jest.restoreAllMocks();
  adopt.mockReset().mockImplementation(async (_source, destination, bytes) => ({
    uri: destination,
    bytes,
  }));
});

it('leaves ordinary picked files on the existing path without reserving or invoking native code', async () => {
  const reserve = jest.spyOn(attachmentCacheCoordinator, 'reserve');
  const image = { ...source, origin: undefined };

  await expect(
    createOutgoingPasteOwnershipPreparer(
      scope(),
      () => true,
    )({
      db,
      image,
      attachmentGuid: 'temp-ordinary-att',
    }),
  ).resolves.toEqual({ image });

  expect(reserve).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
});

it('refuses paste admission while startup cache recovery is not ready', async () => {
  const reserve = jest.spyOn(attachmentCacheCoordinator, 'reserve');

  await expect(
    createOutgoingPasteOwnershipPreparer(
      scope(),
      () => false,
    )({
      db,
      image: source,
      attachmentGuid: 'temp-att',
    }),
  ).rejects.toThrow('no longer available');

  expect(reserve).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
});

it('reserves the generation path before moving and returns only the adopted durable URI', async () => {
  const destination =
    'file:///documents/attachments/media-temp-att/generation-7/media-photo%20one.jpg';
  const owned = reservation(destination);
  const reserve = jest
    .spyOn(attachmentCacheCoordinator, 'reserve')
    .mockResolvedValue({ status: 'reserved', reservation: owned });

  await expect(
    createOutgoingPasteOwnershipPreparer(
      scope(),
      () => true,
    )({
      db,
      image: source,
      attachmentGuid: 'temp-att',
    }),
  ).resolves.toEqual({
    image: { ...source, uri: destination },
    cacheReservation: owned,
  });

  expect(reserve).toHaveBeenCalledWith(db, {
    path: destination,
    maxBytes: 42,
    scope: expect.objectContaining({ generation: 7 }),
  });
  expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(adopt.mock.invocationCallOrder[0]!);
  expect(adopt).toHaveBeenCalledWith(source.uri, destination, 42);
  expect(owned.release).not.toHaveBeenCalled();
});

it('fails closed before native movement when quota admission refuses the destination', async () => {
  jest.spyOn(attachmentCacheCoordinator, 'reserve').mockResolvedValue({ status: 'storage' });

  await expect(
    createOutgoingPasteOwnershipPreparer(
      scope(),
      () => true,
    )({
      db,
      image: source,
      attachmentGuid: 'temp-att',
    }),
  ).rejects.toThrow('Not enough storage');
  expect(adopt).not.toHaveBeenCalled();
});

it('releases the durable reservation when native movement fails or the account turns stale', async () => {
  const destination =
    'file:///documents/attachments/media-temp-att/generation-7/media-photo%20one.jpg';
  const nativeFailureOwner = reservation(destination);
  const staleOwner = reservation(destination);
  jest
    .spyOn(attachmentCacheCoordinator, 'reserve')
    .mockResolvedValueOnce({ status: 'reserved', reservation: nativeFailureOwner })
    .mockResolvedValueOnce({ status: 'reserved', reservation: staleOwner });

  adopt.mockRejectedValueOnce(new Error('native move rejected'));
  await expect(
    createOutgoingPasteOwnershipPreparer(
      scope(),
      () => true,
    )({
      db,
      image: source,
      attachmentGuid: 'temp-att',
    }),
  ).rejects.toThrow('native move rejected');
  expect(nativeFailureOwner.release).toHaveBeenCalledTimes(1);

  let checks = 0;
  const goesStale = scope(() => {
    checks += 1;
    return checks < 3;
  });
  await expect(
    createOutgoingPasteOwnershipPreparer(
      goesStale,
      () => true,
    )({
      db,
      image: source,
      attachmentGuid: 'temp-att',
    }),
  ).rejects.toThrow('no longer available');
  expect(staleOwner.release).toHaveBeenCalledTimes(1);
});
