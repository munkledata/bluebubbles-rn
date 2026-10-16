/**
 * Device and service stubs that every chat-screen route test needs in the same form (review M007).
 * Import this file first, before the screen, so these mocks register before anything loads them.
 * Mocks a test shapes for its own scenario (router, hooks, repositories) stay in that test.
 */
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
}));

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => R.createElement(View, props) };
});

jest.mock('@/services/contacts/contactsService', () => ({
  getContactsPermissionState: jest.fn(),
}));

jest.mock('@/services/notifications/notifeeService', () => ({ clearChatNotification: jest.fn() }));

jest.mock('@/services/notifications/remindersService', () => ({
  scheduleMessageReminder: jest.fn(),
}));

jest.mock('@/services/remoteMessageDeleteUiService', () => ({
  deleteMessageFromMac: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));

export {};
