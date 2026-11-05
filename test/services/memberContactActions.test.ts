import {
  callMember,
  canViewMemberContact,
  copyMemberAddress,
  emailMember,
  openMemberContact,
  type MemberContactActionDependencies,
} from '@/services/memberContactActions';

function fakeDependencies(overrides: Partial<MemberContactActionDependencies> = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const dependencies: MemberContactActionDependencies = {
    openUrl: async (url) => {
      calls.push({ kind: 'openUrl', args: [url] });
      return true;
    },
    copyText: async (text) => {
      calls.push({ kind: 'copyText', args: [text] });
    },
    startActivity: async (action, params) => {
      calls.push({ kind: 'startActivity', args: [action, params] });
    },
    isAndroid: () => true,
    ...overrides,
  };
  return { calls, dependencies };
}

describe('member contact actions', () => {
  it('copies the trimmed address and reports a failed copy', async () => {
    const { calls, dependencies } = fakeDependencies();
    expect(await copyMemberAddress(' +15551112222 ', dependencies)).toBe(true);
    expect(calls).toEqual([{ kind: 'copyText', args: ['+15551112222'] }]);

    const failing = fakeDependencies({
      copyText: async () => {
        throw new Error('planted clipboard failure');
      },
    });
    expect(await copyMemberAddress('+15551112222', failing.dependencies)).toBe(false);
    expect(await copyMemberAddress('   ', dependencies)).toBe(false);
  });

  it('calls only a dialable number and emails only an email address', async () => {
    const { calls, dependencies } = fakeDependencies();
    expect(await callMember('+1 (555) 111-2222', dependencies)).toBe(true);
    expect(await emailMember('craig@apple.com', dependencies)).toBe(true);
    expect(await callMember('37542', dependencies)).toBe(false);
    expect(await callMember('craig@apple.com', dependencies)).toBe(false);
    expect(await emailMember('+15551112222', dependencies)).toBe(false);
    expect(calls).toEqual([
      { kind: 'openUrl', args: ['tel:+15551112222'] },
      { kind: 'openUrl', args: ['mailto:craig@apple.com'] },
    ]);
  });

  it('opens a linked contact by its id, and otherwise offers to add the number or email', async () => {
    const { calls, dependencies } = fakeDependencies();
    expect(
      await openMemberContact({ address: '+15551112222', contactSourceId: '101' }, dependencies),
    ).toBe(true);
    expect(
      await openMemberContact({ address: '+1 555 111 2222', contactSourceId: null }, dependencies),
    ).toBe(true);
    expect(
      await openMemberContact({ address: 'craig@apple.com', contactSourceId: null }, dependencies),
    ).toBe(true);
    expect(calls).toEqual([
      {
        kind: 'startActivity',
        args: [
          'android.intent.action.VIEW',
          { data: 'content://com.android.contacts/contacts/101' },
        ],
      },
      {
        kind: 'startActivity',
        args: [
          'android.intent.action.INSERT_OR_EDIT',
          { type: 'vnd.android.cursor.item/contact', extra: { phone: '+15551112222' } },
        ],
      },
      {
        kind: 'startActivity',
        args: [
          'android.intent.action.INSERT_OR_EDIT',
          { type: 'vnd.android.cursor.item/contact', extra: { email: 'craig@apple.com' } },
        ],
      },
    ]);
  });

  it('never builds a contact link from an id that is not a plain Android row id', async () => {
    expect(canViewMemberContact('101')).toBe(true);
    for (const id of ['', '10a', '../1', '1/edit', '101?x=1', null, undefined]) {
      expect(canViewMemberContact(id)).toBe(false);
    }
    const { calls, dependencies } = fakeDependencies();
    // An unusable id falls back to adding the number, never to a content link built from it.
    await openMemberContact({ address: '+15551112222', contactSourceId: '1/edit' }, dependencies);
    expect(calls[0]?.args[0]).toBe('android.intent.action.INSERT_OR_EDIT');
  });

  it('does nothing for a short code, off Android, or when the Contacts app refuses', async () => {
    const { calls, dependencies } = fakeDependencies();
    expect(await openMemberContact({ address: '37542', contactSourceId: null }, dependencies)).toBe(
      false,
    );
    const ios = fakeDependencies({ isAndroid: () => false });
    expect(
      await openMemberContact(
        { address: '+15551112222', contactSourceId: '101' },
        ios.dependencies,
      ),
    ).toBe(false);
    const refusing = fakeDependencies({
      startActivity: async () => {
        throw new Error('planted: no activity found');
      },
    });
    expect(
      await openMemberContact(
        { address: '+15551112222', contactSourceId: '101' },
        refusing.dependencies,
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(ios.calls).toEqual([]);
  });
});
