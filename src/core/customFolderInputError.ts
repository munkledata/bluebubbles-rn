/**
 * A folder change the owner can fix by changing the name or removing a folder. Its message is
 * written for the owner; every other folder failure stays a generic message.
 */
export class CustomFolderInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'CustomFolderInputError';
  }
}
