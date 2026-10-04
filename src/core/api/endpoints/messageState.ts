import { MessageStatePage } from '@core/models/messageState';
import type { HttpClient } from '../http';
import { ApiError } from '../errors';
import { z } from 'zod/v4';
import { Message } from '@core/models';

export class MessageStateRepairRequiredError extends Error {
  constructor(cause?: unknown) {
    super('A stable iMessage refresh is required before deletion sync can continue.', { cause });
    this.name = 'MessageStateRepairRequiredError';
  }
}

export async function page(
  http: HttpClient,
  cursor?: string,
  signal?: AbortSignal,
): Promise<MessageStatePage> {
  try {
    return await http.post('/sync/message-state', MessageStatePage, {
      json: { version: 1, provider: 'imessage', ...(cursor ? { cursor } : {}) },
      signal,
      retry: false,
      captureErrorDetail: true,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.serverErrorType === 'repair_required'
    ) {
      throw new MessageStateRepairRequiredError(error);
    }
    throw error;
  }
}

export async function activeMessage(
  http: HttpClient,
  guid: string,
  providerEpoch: string,
  signal?: AbortSignal,
): Promise<Message | null> {
  try {
    const result = await http.post(
      '/sync/message-state/message',
      z.object({ message: Message }).strict(),
      {
        json: { version: 1, provider: 'imessage', providerEpoch, guid },
        signal,
        retry: false,
        captureErrorDetail: true,
      },
    );
    return result.message;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.serverErrorType === 'repair_required'
    )
      throw new MessageStateRepairRequiredError(error);
    throw error;
  }
}
