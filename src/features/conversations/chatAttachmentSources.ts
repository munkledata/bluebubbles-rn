import {
  listChatAttachmentsPage,
  listChatLinksPage,
  type ChatDocumentRow,
  type ChatLink,
} from '@db/repositories';
import type { ChatPagedRowSource } from './useChatPagedRows';

/** The All Attachments tabs' paged reads (each kind is a separate bounded query). */
export const CHAT_PHOTOS: ChatPagedRowSource<ChatDocumentRow> = {
  id: 'photos',
  fetchPage: (db, chatGuid, limit) => listChatAttachmentsPage(db, chatGuid, 'photo', limit),
  rowKey: (row) => row.guid,
};

export const CHAT_VIDEOS: ChatPagedRowSource<ChatDocumentRow> = {
  id: 'videos',
  fetchPage: (db, chatGuid, limit) => listChatAttachmentsPage(db, chatGuid, 'video', limit),
  rowKey: (row) => row.guid,
};

export const CHAT_FILES: ChatPagedRowSource<ChatDocumentRow> = {
  id: 'files',
  fetchPage: (db, chatGuid, limit) => listChatAttachmentsPage(db, chatGuid, 'document', limit),
  rowKey: (row) => row.guid,
};

/** Links are keyed by URL: the read keeps one row per URL, at its newest message. */
export const CHAT_LINKS: ChatPagedRowSource<ChatLink> = {
  id: 'links',
  fetchPage: (db, chatGuid, limit) => listChatLinksPage(db, chatGuid, limit),
  rowKey: (row) => row.url,
};
