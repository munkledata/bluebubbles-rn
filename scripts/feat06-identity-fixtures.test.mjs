import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FIXTURE_URL = new URL('../docs/fixtures/FEAT_06_IDENTITY_FIXTURES.json', import.meta.url);
const MISSING_GOOGLE_EPOCH_CASE_ID = 'google-conversation-missing-provider-epoch';
const REQUIRED_REVIEW_CASE_IDS = [
  'same-contact-two-phone-numbers',
  'same-contact-rcs-and-sms-different-numbers',
  'same-contact-google-rcs-and-google-sms-different-numbers',
  'same-number-rcs-and-imessage',
  'google-rcs-to-sms-fallback-same-source-conversation',
  'same-number-google-messages-and-apple-sms',
  'shared-contact-actions-route-by-conversation',
  'cross-chat-reply-reference',
  'cross-chat-reaction-reference',
  'cross-chat-sticker-reference',
  'cross-chat-thread-reference',
  'ambiguous-shared-contact-endpoint',
  MISSING_GOOGLE_EPOCH_CASE_ID,
  'backup-provider-epoch-mismatch',
  'backup-stale-reassigned-contact',
  'pagination-insert-changes-snapshot',
  'pagination-equal-timestamp-tiebreak',
  'pagination-provider-generation-rotation',
  'pagination-cancelled-incomplete',
  'privacy-scope-and-minimal-response',
  'old-server-without-identity-capability',
  'same-display-name-different-people',
  'local-number-without-region',
  'phone-extension-not-base-number',
];

const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));

function caseById(id) {
  const fixtureCase = fixture.cases.find((candidate) => candidate.id === id);
  assert.ok(fixtureCase, `missing fixture case: ${id}`);
  return fixtureCase;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, label) {
  assert.ok(isRecord(value), `${label} must be an object`);
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.notEqual(value.trim(), '', `${label} must not be empty`);
}

function sidesOf(fixtureCase) {
  return [
    ['left', fixtureCase.left],
    ['right', fixtureCase.right],
  ];
}

test('FEAT-06 identity fixture has the required root and case shapes', () => {
  assertRecord(fixture, 'fixture');
  assert.equal(fixture.version, 1, 'fixture.version must be 1');
  assertRecord(fixture.policy, 'fixture.policy');
  assert.ok(Array.isArray(fixture.cases), 'fixture.cases must be an array');
  assert.ok(fixture.cases.length > 0, 'fixture.cases must not be empty');

  for (const [index, fixtureCase] of fixture.cases.entries()) {
    const label = `fixture.cases[${index}]`;
    assertRecord(fixtureCase, label);
    assertNonEmptyString(fixtureCase.id, `${label}.id`);
    assertRecord(fixtureCase.left, `${fixtureCase.id}.left`);
    assertRecord(fixtureCase.right, `${fixtureCase.id}.right`);
    assertRecord(fixtureCase.expected, `${fixtureCase.id}.expected`);

    for (const [sideName, side] of sidesOf(fixtureCase)) {
      const hasIdentityKey = side.provider !== undefined || side.chatGuid !== undefined;
      if (hasIdentityKey) {
        assertNonEmptyString(side.accountRealm, `${fixtureCase.id}.${sideName}.accountRealm`);
        assertNonEmptyString(side.provider, `${fixtureCase.id}.${sideName}.provider`);
        assertNonEmptyString(side.transport, `${fixtureCase.id}.${sideName}.transport`);
      }
      if (side.chatGuid !== undefined) {
        assertNonEmptyString(side.chatGuid, `${fixtureCase.id}.${sideName}.chatGuid`);
      }
      if (side.providerEpoch !== undefined) {
        assertNonEmptyString(side.providerEpoch, `${fixtureCase.id}.${sideName}.providerEpoch`);
      }
    }

    assertNonEmptyString(fixtureCase.expected.relation, `${fixtureCase.id}.expected.relation`);
    assertNonEmptyString(
      fixtureCase.expected.disposition,
      `${fixtureCase.id}.expected.disposition`,
    );
    assert.equal(
      typeof fixtureCase.expected.shareTranscript,
      'boolean',
      `${fixtureCase.id}.expected.shareTranscript must be a boolean`,
    );
    assert.equal(
      typeof fixtureCase.expected.shareConversationState,
      'boolean',
      `${fixtureCase.id}.expected.shareConversationState must be a boolean`,
    );
    assert.equal(
      typeof fixtureCase.expected.routeByContactMatch,
      'boolean',
      `${fixtureCase.id}.expected.routeByContactMatch must be a boolean`,
    );
  }
});

test('FEAT-06 case ids are unique and retain every reviewed edge case', () => {
  const ids = fixture.cases.map((fixtureCase) => fixtureCase.id);
  assert.equal(new Set(ids).size, ids.length, 'fixture case ids must be unique');

  const missingIds = REQUIRED_REVIEW_CASE_IDS.filter((id) => !ids.includes(id));
  assert.deepEqual(missingIds, [], `missing reviewed fixture cases: ${missingIds.join(', ')}`);
});

test('FEAT-06 high-risk cases retain the no-merge and fail-closed decisions', () => {
  assert.deepEqual(fixture.policy.supportedProviders, ['apple_messages', 'google_messages']);
  assert.equal(fixture.policy.contactPresentationOnly, true);
  assert.equal(fixture.policy.mergeDistinctTranscripts, false);
  assert.equal(fixture.policy.mergeDifferentNumbers, false);
  assert.equal(fixture.policy.mergeRcsWithAppleMessages, false);

  const fallback = caseById('google-rcs-to-sms-fallback-same-source-conversation');
  assert.equal(fallback.left.provider, 'google_messages');
  assert.equal(fallback.right.provider, 'google_messages');
  assert.equal(fallback.left.transport, 'rcs');
  assert.equal(fallback.right.transport, 'sms');
  assert.equal(fallback.left.accountRealm, fallback.right.accountRealm);
  assert.equal(fallback.left.providerEpoch, fallback.right.providerEpoch);
  assert.equal(fallback.left.chatGuid, fallback.right.chatGuid);
  assert.equal(fallback.expected.shareTranscript, true);
  assert.equal(fallback.expected.shareConversationState, true);
  assert.equal(fallback.expected.disposition, 'retain-google-provider-owner');

  for (const id of [
    'same-contact-two-phone-numbers',
    'same-contact-rcs-and-sms-different-numbers',
    'same-contact-google-rcs-and-google-sms-different-numbers',
  ]) {
    const differentNumbers = caseById(id);
    assert.equal(differentNumbers.left.contactSourceId, differentNumbers.right.contactSourceId);
    assert.notEqual(differentNumbers.left.address, differentNumbers.right.address);
    assert.notEqual(differentNumbers.left.chatGuid, differentNumbers.right.chatGuid);
    assert.equal(differentNumbers.expected.shareTranscript, false);
    assert.equal(differentNumbers.expected.shareConversationState, false);
  }

  const separateGoogleNumbers = caseById(
    'same-contact-google-rcs-and-google-sms-different-numbers',
  );
  assert.equal(separateGoogleNumbers.left.provider, 'google_messages');
  assert.equal(separateGoogleNumbers.right.provider, 'google_messages');
  assert.equal(separateGoogleNumbers.left.transport, 'rcs');
  assert.equal(separateGoogleNumbers.right.transport, 'sms');
  assert.equal(separateGoogleNumbers.left.providerEpoch, separateGoogleNumbers.right.providerEpoch);
  assert.equal(separateGoogleNumbers.expected.disposition, 'retain-both-google-conversations');

  const rcsAndImessage = caseById('same-number-rcs-and-imessage');
  assert.equal(rcsAndImessage.left.address, rcsAndImessage.right.address);
  assert.equal(rcsAndImessage.left.provider, 'google_messages');
  assert.equal(rcsAndImessage.right.provider, 'apple_messages');
  assert.notEqual(rcsAndImessage.left.chatGuid, rcsAndImessage.right.chatGuid);
  assert.equal(rcsAndImessage.expected.shareTranscript, false);

  const sameNumber = caseById('same-number-google-messages-and-apple-sms');
  assert.equal(sameNumber.left.address, sameNumber.right.address);
  assert.equal(sameNumber.left.provider, 'google_messages');
  assert.equal(sameNumber.right.provider, 'apple_messages');
  assert.equal(sameNumber.expected.shareTranscript, false);

  const actions = caseById('shared-contact-actions-route-by-conversation').expected.actions;
  assert.deepEqual(actions, {
    markRead: 'exact-origin-conversation-only',
    delete: 'exact-origin-conversation-only',
    searchNavigation: 'exact-origin-conversation-only',
    notificationTap: 'exact-origin-conversation-only',
  });

  const missingEpoch = caseById(MISSING_GOOGLE_EPOCH_CASE_ID);
  assert.equal(missingEpoch.left.validIdentity, false);
  assert.equal(missingEpoch.expected.inputDisposition, 'reject');

  const backupMatch = caseById('backup-unique-same-service-replacement');
  assert.equal(backupMatch.left.identityVersion, backupMatch.right.identityVersion);
  assert.equal(backupMatch.left.serverChatIdentifier, backupMatch.right.serverChatIdentifier);
  assert.deepEqual(backupMatch.left.participants, backupMatch.right.participants);
  assert.equal(backupMatch.left.address, backupMatch.right.address);
  assert.equal(backupMatch.left.regionEvidence, backupMatch.right.regionEvidence);

  const oldServer = caseById('old-server-without-identity-capability');
  assert.equal(oldServer.left.supportsIdentityDirectoryV1, false);
  assert.match(oldServer.expected.disposition, /no-association/);

  const privacy = caseById('privacy-scope-and-minimal-response');
  assert.equal(privacy.left.returnsWholeAddressBook, false);
  assert.equal(privacy.right.returnsOnlyRequestedMatches, true);
  assert.equal(privacy.expected.logContactNames, false);
  assert.equal(privacy.expected.logEndpoints, false);
  assert.equal(privacy.expected.logParticipantIds, false);
});

test('FEAT-06 message references retain their exact owning conversation', () => {
  const referenceCases = new Map([
    ['cross-chat-reply-reference', 'ignore-cross-chat-reference'],
    ['cross-chat-reaction-reference', 'ignore-cross-chat-reaction'],
    ['cross-chat-sticker-reference', 'ignore-cross-chat-sticker'],
    ['cross-chat-thread-reference', 'ignore-cross-chat-thread'],
  ]);

  for (const [id, disposition] of referenceCases) {
    const fixtureCase = caseById(id);
    assert.notEqual(fixtureCase.left.chatGuid, fixtureCase.right.chatGuid);
    assert.equal(fixtureCase.left.referencesMessageGuid, fixtureCase.right.messageGuid);
    assert.equal(fixtureCase.expected.relation, 'invalid-reference');
    assert.equal(fixtureCase.expected.disposition, disposition);
  }
});

test('FEAT-06 backup cases require exact evidence and fail closed', () => {
  const positive = caseById('backup-unique-same-service-replacement');
  assert.equal(positive.left.provider, positive.right.provider);
  assert.equal(positive.left.transport, positive.right.transport);
  assert.equal(positive.left.conversationKind, 'direct');
  assert.equal(positive.right.conversationKind, 'direct');
  assert.notEqual(positive.left.chatGuid, positive.right.chatGuid);
  assert.equal(positive.left.identityVersion, positive.right.identityVersion);
  assert.equal(positive.left.serverChatIdentifier, positive.right.serverChatIdentifier);
  assert.deepEqual(positive.left.participants, [positive.left.address]);
  assert.deepEqual(positive.right.participants, [positive.right.address]);
  assert.match(positive.left.address, /^\+[1-9]\d+$/);
  assert.equal(positive.left.address, positive.right.address);
  assert.equal(positive.left.regionEvidence, positive.right.regionEvidence);
  assert.equal(
    positive.expected.backupDisposition,
    'copy-customization-only-after-unique-versioned-match',
  );
  assert.equal(positive.expected.disposition, 'no-message-restore');

  const epochMismatch = caseById('backup-provider-epoch-mismatch');
  assert.equal(epochMismatch.left.provider, 'google_messages');
  assert.equal(epochMismatch.right.provider, 'google_messages');
  assert.notEqual(epochMismatch.left.providerEpoch, epochMismatch.right.providerEpoch);
  assert.equal(epochMismatch.expected.backupDisposition, 'skip-and-report');
  assert.equal(epochMismatch.expected.disposition, 'reject-backup-provider-epoch-mismatch');

  const reassignedContact = caseById('backup-stale-reassigned-contact');
  assert.equal(
    reassignedContact.left.serverChatIdentifier,
    reassignedContact.right.serverChatIdentifier,
  );
  assert.notEqual(reassignedContact.left.contactSourceId, reassignedContact.right.contactSourceId);
  assert.equal(reassignedContact.expected.backupDisposition, 'discard-stale-contact-link');
  assert.equal(reassignedContact.expected.disposition, 'contact-metadata-never-restores-identity');
});

test('FEAT-06 pagination cases are snapshot-bound and publish only complete generations', () => {
  const inserted = caseById('pagination-insert-changes-snapshot');
  assert.notEqual(inserted.left.snapshotToken, inserted.right.snapshotToken);
  assert.equal(inserted.left.page, 1);
  assert.equal(inserted.right.page, 2);
  assert.equal(inserted.expected.publishPartialResults, false);
  assert.equal(inserted.expected.disposition, 'discard-pages-and-restart');

  const equalTime = caseById('pagination-equal-timestamp-tiebreak');
  assert.equal(equalTime.left.snapshotToken, equalTime.right.snapshotToken);
  assert.equal(equalTime.left.sortTimestamp, equalTime.right.sortTimestamp);
  assert.notEqual(equalTime.left.tieBreakId, equalTime.right.tieBreakId);
  assert.equal(equalTime.expected.disposition, 'order-by-timestamp-then-exact-id');

  const rotated = caseById('pagination-provider-generation-rotation');
  assert.notEqual(rotated.left.providerEpoch, rotated.right.providerEpoch);
  assert.notEqual(rotated.left.snapshotToken, rotated.right.snapshotToken);
  assert.equal(rotated.expected.publishPartialResults, false);
  assert.equal(rotated.expected.disposition, 'discard-pages-and-restart');

  const cancelled = caseById('pagination-cancelled-incomplete');
  assert.equal(cancelled.left.scanState, 'cancelled-incomplete');
  assert.equal(cancelled.right.scanState, 'complete');
  assert.equal(cancelled.expected.publishPartialResults, false);
  assert.equal(cancelled.expected.disposition, 'retain-last-complete-generation');
});

test('FEAT-06 privacy, capability, and ambiguous endpoint cases retain their boundaries', () => {
  const privacy = caseById('privacy-scope-and-minimal-response');
  assert.equal(privacy.left.requiredScope, 'messages:read');
  assert.ok(privacy.left.requestedEndpointCount > 0);
  assert.equal(privacy.left.returnsWholeAddressBook, false);
  assert.equal(privacy.right.requiredScope, 'personal-data:read');
  assert.equal(privacy.right.combinedResponseRequiresBothScopes, true);
  assert.equal(privacy.right.returnsOnlyRequestedMatches, true);

  const oldServer = caseById('old-server-without-identity-capability');
  assert.equal(oldServer.left.supportsIdentityDirectoryV1, false);
  assert.equal(oldServer.left.legacyHandleQueryAvailable, true);
  assert.equal(oldServer.right.requiresCapability, 'supports_identity_directory_v1');
  assert.equal(oldServer.right.clientAction, 'automatic-contact-association');

  const ambiguousContact = caseById('ambiguous-shared-contact-endpoint');
  assert.equal(ambiguousContact.left.address, ambiguousContact.right.address);
  assert.notEqual(ambiguousContact.left.contactSourceId, ambiguousContact.right.contactSourceId);
  assert.equal(ambiguousContact.expected.maySharePresentation, false);
  assert.equal(ambiguousContact.expected.routeByContactMatch, false);
  assert.equal(ambiguousContact.expected.disposition, 'leave-contact-unlinked');

  const duplicateName = caseById('same-display-name-different-people');
  assert.equal(duplicateName.left.displayName, duplicateName.right.displayName);
  assert.notEqual(duplicateName.left.rawParticipantId, duplicateName.right.rawParticipantId);
  assert.notEqual(duplicateName.left.address, duplicateName.right.address);
  assert.notEqual(duplicateName.left.chatGuid, duplicateName.right.chatGuid);
  assert.equal(duplicateName.expected.disposition, 'reject-name-only-match');

  const localNumber = caseById('local-number-without-region');
  assert.equal(localNumber.left.regionEvidence, null);
  assert.equal(localNumber.right.regionEvidence, 'US');
  assert.notEqual(localNumber.left.address, localNumber.right.address);
  assert.equal(localNumber.expected.disposition, 'reject-region-inference');

  const extension = caseById('phone-extension-not-base-number');
  assert.match(extension.left.address, /;ext=/);
  assert.equal(extension.left.address.split(';')[0], extension.right.address);
  assert.notEqual(extension.left.chatGuid, extension.right.chatGuid);
  assert.equal(extension.expected.disposition, 'reject-extension-stripping');
});

test('FEAT-06 invalid or placeholder identities are explicitly rejected', () => {
  const supportedProviders = new Set(fixture.policy.supportedProviders);

  for (const fixtureCase of fixture.cases) {
    for (const [, side] of sidesOf(fixtureCase)) {
      const unsupportedProvider =
        side.provider !== undefined && !supportedProviders.has(side.provider);
      const invalidGoogleEpoch =
        side.provider === 'google_messages' &&
        (typeof side.providerEpoch !== 'string' ||
          side.providerEpoch.trim() === '' ||
          side.providerEpoch.toLowerCase() === 'unknown');

      if (unsupportedProvider || invalidGoogleEpoch) {
        assert.equal(side.validIdentity, false, `${fixtureCase.id} must mark invalid input`);
        assert.equal(
          fixtureCase.expected.inputDisposition,
          'reject',
          `${fixtureCase.id} must reject invalid input`,
        );
      }
    }
  }
});

test('FEAT-06 Google conversation records require a provider epoch', () => {
  const missingEpochRecords = [];

  for (const fixtureCase of fixture.cases) {
    for (const [sideName, side] of sidesOf(fixtureCase)) {
      if (side.provider !== 'google_messages') {
        continue;
      }
      if (typeof side.providerEpoch !== 'string' || side.providerEpoch.trim() === '') {
        missingEpochRecords.push(`${fixtureCase.id}.${sideName}`);
      }
    }
  }

  assert.ok(missingEpochRecords.length > 0, 'the explicit missing-epoch rejection case is absent');
  assert.deepEqual(
    [...new Set(missingEpochRecords.map((record) => record.split('.')[0]))],
    [MISSING_GOOGLE_EPOCH_CASE_ID],
    'only the explicit missing-epoch rejection case may omit a Google provider epoch',
  );

  const rejectionCase = fixture.cases.find(
    (fixtureCase) => fixtureCase.id === MISSING_GOOGLE_EPOCH_CASE_ID,
  );
  assert.ok(rejectionCase, 'the explicit missing-epoch rejection case must exist');
  assert.equal(rejectionCase.expected.shareTranscript, false);
  assert.equal(rejectionCase.expected.shareConversationState, false);
  assert.match(
    rejectionCase.expected.disposition,
    /(?:reject.*epoch|epoch.*reject)/i,
    'the missing-epoch case must explicitly reject the record',
  );
});

test('FEAT-06 same-conversation cases use the exact owner key', () => {
  const sameConversationCases = fixture.cases.filter((fixtureCase) =>
    fixtureCase.expected.relation.startsWith('same-conversation'),
  );
  assert.ok(sameConversationCases.length > 0, 'at least one same-conversation case is required');

  for (const fixtureCase of sameConversationCases) {
    const { left, right, expected } = fixtureCase;
    assertNonEmptyString(left.chatGuid, `${fixtureCase.id}.left.chatGuid`);
    assertNonEmptyString(right.chatGuid, `${fixtureCase.id}.right.chatGuid`);
    assert.equal(
      right.accountRealm,
      left.accountRealm,
      `${fixtureCase.id} account realm must match`,
    );
    assert.equal(right.provider, left.provider, `${fixtureCase.id} provider must match`);
    assert.equal(right.chatGuid, left.chatGuid, `${fixtureCase.id} exact chat GUID must match`);
    if (left.provider === 'google_messages') {
      assertNonEmptyString(left.providerEpoch, `${fixtureCase.id}.left.providerEpoch`);
      assert.equal(
        right.providerEpoch,
        left.providerEpoch,
        `${fixtureCase.id} Google provider epoch must match`,
      );
    }
    assert.equal(expected.shareTranscript, true, `${fixtureCase.id} must share its transcript`);
    assert.equal(
      expected.shareConversationState,
      true,
      `${fixtureCase.id} must share conversation state`,
    );
  }
});

test('FEAT-06 never shares non-conversation state or routes by contact match', () => {
  for (const fixtureCase of fixture.cases) {
    const { expected } = fixtureCase;
    assert.equal(
      expected.routeByContactMatch,
      false,
      `${fixtureCase.id} must route by the conversation owner, not a contact match`,
    );

    if (!expected.relation.startsWith('same-conversation')) {
      assert.equal(
        expected.shareTranscript,
        false,
        `${fixtureCase.id} must not share a transcript`,
      );
      assert.equal(
        expected.shareConversationState,
        false,
        `${fixtureCase.id} must not share conversation state`,
      );
    }
  }
});
