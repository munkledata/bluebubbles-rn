import {
  canSendRestoredIMessageAttachments,
  canSendRestoredIMessageReply,
  canSendRestoredIMessageSubject,
  canSendRestoredIMessageTapback,
  canUseRestoredIMessageGroupFeature,
  IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES,
  IMESSAGE_RESTORED_ATTACHMENT_MAX_TOTAL_BYTES,
  IMESSAGE_RESTORED_FEATURES,
  isValidRestoredSubject,
  restoredAttachmentBatchRefusal,
  restoredAttachmentExtension,
  restoredChatKind,
  restoredGroupCommandsAcceptAnyPrefix,
  serverSendCapabilityKey,
  ServerInfo,
} from '@core/models';
import { isProvenIMessageGroupChat } from '@utils';

const MIB = 1024 * 1024;
const info = (fields: Record<string, unknown>) =>
  ServerInfo.parse({ version: '2.0.38', ...fields });

describe('FP-006 restored server-info flags', () => {
  it('parses all fourteen optional flags and keeps them absent on an older server', () => {
    expect(IMESSAGE_RESTORED_FEATURES).toHaveLength(14);
    const old = info({});
    for (const flag of IMESSAGE_RESTORED_FEATURES) expect(old[flag]).toBeUndefined();
    const all = info(Object.fromEntries(IMESSAGE_RESTORED_FEATURES.map((flag) => [flag, true])));
    for (const flag of IMESSAGE_RESTORED_FEATURES) expect(all[flag]).toBe(true);
  });

  it('changes the send-capability key when any restored flag flips', () => {
    const base = serverSendCapabilityKey(info({}));
    for (const flag of IMESSAGE_RESTORED_FEATURES) {
      expect(serverSendCapabilityKey(info({ [flag]: true }))).not.toBe(base);
    }
    // Explicit false reads exactly like an old server that sends nothing.
    expect(
      serverSendCapabilityKey(
        info(Object.fromEntries(IMESSAGE_RESTORED_FEATURES.map((flag) => [flag, false]))),
      ),
    ).toBe(base);
  });
});

describe('restoredChatKind', () => {
  it.each([
    ['iMessage;-;+1555', 'direct'],
    ['any;-;a@b.c', 'direct'],
    ['iMessage;+;chat1', 'group'],
    ['any;+;chat1', 'group'],
    ['SMS;-;+1555', undefined],
    ['RCS;-;thread', undefined],
    ['any;+;', undefined],
    [' any;+;chat1', undefined],
  ])('%s -> %s', (guid, kind) => {
    expect(restoredChatKind(guid)).toBe(kind);
  });
});

describe('restored request gates mirror the server', () => {
  it('needs nothing restored for a one-to-one classic part-zero tapback', () => {
    // An empty feature list never counts as restored: that request stays on the reviewed path.
    expect(
      canSendRestoredIMessageTapback(info({}), {
        chatGuid: 'iMessage;-;+1',
        reaction: 'love',
        partIndex: 0,
      }),
    ).toBe(false);
  });

  it('needs every switch a tapback uses', () => {
    const request = { chatGuid: 'any;+;g1', reaction: 'emoji', partIndex: 2 };
    expect(
      canSendRestoredIMessageTapback(
        info({
          supports_imessage_group_reactions: true,
          supports_imessage_emoji_reactions: true,
        }),
        request,
      ),
    ).toBe(false);
    expect(
      canSendRestoredIMessageTapback(
        info({
          supports_imessage_group_reactions: true,
          supports_imessage_emoji_reactions: true,
          supports_imessage_part_reactions: true,
        }),
        request,
      ),
    ).toBe(true);
    expect(
      canSendRestoredIMessageTapback(info({ supports_imessage_emoji_reactions: true }), {
        chatGuid: 'iMessage;-;+1',
        reaction: '-emoji',
        partIndex: 0,
      }),
    ).toBe(true);
    expect(
      canSendRestoredIMessageTapback(info({ supports_imessage_group_reactions: true }), {
        chatGuid: 'SMS;+;g1',
        reaction: 'love',
        partIndex: 0,
      }),
    ).toBe(false);
  });

  it('needs the group and part switches for a reply', () => {
    expect(
      canSendRestoredIMessageReply(info({ supports_imessage_group_replies: true }), {
        chatGuid: 'any;+;g1',
        partIndex: 0,
      }),
    ).toBe(true);
    expect(
      canSendRestoredIMessageReply(info({ supports_imessage_group_replies: true }), {
        chatGuid: 'any;+;g1',
        partIndex: 1,
      }),
    ).toBe(false);
    expect(
      canSendRestoredIMessageReply(info({ supports_imessage_part_replies: true }), {
        chatGuid: 'iMessage;-;+1',
        partIndex: 1,
      }),
    ).toBe(true);
  });

  it('needs both attachment switches in a group and only v2 one-to-one', () => {
    expect(
      canSendRestoredIMessageAttachments(
        info({ supports_imessage_attachments_v2: true }),
        'any;-;+1',
      ),
    ).toBe(true);
    expect(
      canSendRestoredIMessageAttachments(
        info({ supports_imessage_attachments_v2: true }),
        'any;+;g',
      ),
    ).toBe(false);
    expect(
      canSendRestoredIMessageAttachments(
        info({ supports_imessage_group_attachment_upload: true }),
        'any;+;g',
      ),
    ).toBe(false);
    expect(
      canSendRestoredIMessageAttachments(
        info({
          supports_imessage_attachments_v2: true,
          supports_imessage_group_attachment_upload: true,
        }),
        'any;+;g',
      ),
    ).toBe(true);
    expect(
      canSendRestoredIMessageAttachments(
        info({ supports_imessage_attachments_v2: true }),
        'RCS;-;thread',
      ),
    ).toBe(false);
  });

  it('opens a group-only command only for a group with its switch on', () => {
    const on = info({ supports_imessage_group_edit: true });
    expect(canUseRestoredIMessageGroupFeature(on, 'any;+;g', 'supports_imessage_group_edit')).toBe(
      true,
    );
    expect(
      canUseRestoredIMessageGroupFeature(on, 'iMessage;-;+1', 'supports_imessage_group_edit'),
    ).toBe(false);
    expect(
      canUseRestoredIMessageGroupFeature(info({}), 'any;+;g', 'supports_imessage_group_edit'),
    ).toBe(false);
    expect(
      canSendRestoredIMessageSubject(info({ supports_imessage_subject: true }), 'any;+;g'),
    ).toBe(true);
    expect(canSendRestoredIMessageSubject(info({}), 'any;+;g')).toBe(false);
  });
});

describe('isProvenIMessageGroupChat any;+; acceptance', () => {
  const group = {
    guid: 'any;+;chat-1',
    style: 43,
    participantCount: 2,
    handleServices: 'iMessage,iMessage',
  };

  it('keeps the reviewed iMessage;+; rule unless the caller opts in', () => {
    expect(isProvenIMessageGroupChat(group)).toBe(false);
    expect(isProvenIMessageGroupChat({ ...group, guid: 'iMessage;+;chat-1' })).toBe(true);
    expect(isProvenIMessageGroupChat(group, { allowAnyGroupPrefix: true })).toBe(true);
  });

  it('still requires an explicitly all-iMessage group even under any;+;', () => {
    expect(
      isProvenIMessageGroupChat(
        { ...group, handleServices: 'iMessage,SMS' },
        { allowAnyGroupPrefix: true },
      ),
    ).toBe(false);
    expect(isProvenIMessageGroupChat({ ...group, style: 45 }, { allowAnyGroupPrefix: true })).toBe(
      false,
    );
    expect(
      isProvenIMessageGroupChat({ ...group, guid: 'SMS;+;chat-1' }, { allowAnyGroupPrefix: true }),
    ).toBe(false);
  });
});

describe('restored multi-file caps', () => {
  it('allows only the server allowlist of extensions', () => {
    expect(restoredAttachmentExtension('clip.MOV')).toBe('mov');
    expect(restoredAttachmentExtension('notes.txt')).toBe('txt');
    expect(restoredAttachmentExtension('app.apk')).toBeUndefined();
    expect(restoredAttachmentExtension('.hidden.png')).toBeUndefined();
    expect(restoredAttachmentExtension('noextension')).toBeUndefined();
  });

  it('refuses each cap the server enforces', () => {
    const file = (name: string, size: number) => ({ name, size });
    expect(restoredAttachmentBatchRefusal([])).toBe('none');
    expect(
      restoredAttachmentBatchRefusal(Array.from({ length: 10 }, (_, i) => file(`p${i}.jpg`, 1))),
    ).toBeNull();
    expect(
      restoredAttachmentBatchRefusal(Array.from({ length: 11 }, (_, i) => file(`p${i}.jpg`, 1))),
    ).toBe('too-many');
    expect(restoredAttachmentBatchRefusal([file('a.exe', 1)])).toBe('type');
    expect(restoredAttachmentBatchRefusal([file('a.png', 0)])).toBe('empty');
    expect(
      restoredAttachmentBatchRefusal([file('a.mov', IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES)]),
    ).toBeNull();
    expect(
      restoredAttachmentBatchRefusal([
        file('a.mov', IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES + 1),
      ]),
    ).toBe('file-too-large');
    expect(restoredAttachmentBatchRefusal([file('a.csv', MIB + 1)])).toBe('text-file-too-large');
    expect(restoredAttachmentBatchRefusal([file('a.png', 1), file('A.PNG', 1)])).toBe(
      'duplicate-name',
    );
    expect(
      restoredAttachmentBatchRefusal([file('a.mov', 100 * MIB), file('b.mov', 100 * MIB)]),
    ).toBeNull();
    expect(100 * MIB * 2).toBe(IMESSAGE_RESTORED_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(
      restoredAttachmentBatchRefusal([
        file('a.mov', 100 * MIB),
        file('b.mov', 100 * MIB),
        file('c.png', 1),
      ]),
    ).toBe('total-too-large');
  });
});

describe('isValidRestoredSubject', () => {
  it('accepts one nonblank line up to 1 KiB and refuses everything else', () => {
    expect(isValidRestoredSubject('Dinner plans')).toBe(true);
    expect(isValidRestoredSubject('é'.repeat(512))).toBe(true);
    expect(isValidRestoredSubject('é'.repeat(513))).toBe(false);
    expect(isValidRestoredSubject('   ')).toBe(false);
    expect(isValidRestoredSubject('two\nlines')).toBe(false);
    expect(isValidRestoredSubject('tab\there')).toBe(false);
    expect(isValidRestoredSubject('obj￼')).toBe(false);
    expect(isValidRestoredSubject('half\ud800')).toBe(false);
  });
});

describe('restoredGroupCommandsAcceptAnyPrefix', () => {
  it('is true only when the server reports at least one restored switch on', () => {
    expect(restoredGroupCommandsAcceptAnyPrefix(null)).toBe(false);
    expect(restoredGroupCommandsAcceptAnyPrefix(ServerInfo.parse({ version: 't' }))).toBe(false);
    expect(
      restoredGroupCommandsAcceptAnyPrefix(
        ServerInfo.parse({ version: 't', supports_imessage_group_rename: true }),
      ),
    ).toBe(false);
    expect(
      restoredGroupCommandsAcceptAnyPrefix(
        ServerInfo.parse({ version: 't', supports_imessage_attachments_v2: true }),
      ),
    ).toBe(true);
  });
});
