import {
  createCustomFolderWithinTransaction,
  CustomFolderInputError,
  normalizeCustomFolderName,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';

describe('custom folder input errors', () => {
  it('marks only problems the owner can fix with the name as user-facing', async () => {
    expect(() => normalizeCustomFolderName('   ')).toThrow(CustomFolderInputError);
    expect(() => normalizeCustomFolderName('bell\u0007')).toThrow(CustomFolderInputError);
    expect(() => normalizeCustomFolderName(42 as unknown as string)).not.toThrow(
      CustomFolderInputError,
    );

    const { db, raw } = await createTestDb();
    try {
      await withDbTransaction(db, (context) =>
        createCustomFolderWithinTransaction(context, 'Work'),
      );
      await expect(
        withDbTransaction(db, (context) => createCustomFolderWithinTransaction(context, 'Work')),
      ).rejects.toThrow(new CustomFolderInputError('A folder with that name already exists.'));
    } finally {
      raw.close();
    }
  });
});
