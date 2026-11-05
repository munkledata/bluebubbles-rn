import { listChatDocumentAttachmentsPage, type ChatDocumentRow } from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import {
  useChatPagedRows,
  type ChatPagedRowSource,
  type ChatPagedRowsState,
} from './useChatPagedRows';

export type SharedDocumentsState = ChatPagedRowsState<ChatDocumentRow>;

const DOCUMENTS: ChatPagedRowSource<ChatDocumentRow> = {
  id: 'documents',
  fetchPage: (db, chatGuid, limit) => listChatDocumentAttachmentsPage(db, chatGuid, limit),
  rowKey: (row) => row.guid,
};

/** Reactive growing-prefix read of one chat's shared documents. See {@link useChatPagedRows}. */
export function useSharedDocuments(
  chatGuid: string | null,
  accountLease: RealtimeDeliveryLease,
  enabled = true,
): SharedDocumentsState {
  return useChatPagedRows(DOCUMENTS, chatGuid, accountLease, enabled);
}
