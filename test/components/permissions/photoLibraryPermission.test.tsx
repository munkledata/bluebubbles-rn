jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

// eslint-disable-next-line import/first
import * as ImagePicker from 'expo-image-picker';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { requestPhotoLibraryAccess } from '@ui/permissions/photoLibraryPermission';

const requestPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;

describe('requestPhotoLibraryAccess', () => {
  it('continues without a dialog when access is granted', async () => {
    requestPermission.mockResolvedValueOnce({ granted: true, status: 'granted' });

    await expect(requestPhotoLibraryAccess(() => true)).resolves.toBe(true);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('shows recovery guidance when access is denied', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false, status: 'denied' });

    await expect(requestPhotoLibraryAccess(() => true)).resolves.toBe(false);
    expect(showDialog).toHaveBeenCalledWith(
      'Photos',
      'Permission denied. Enable Photos access in system settings to choose an image.',
    );
  });

  it('reports a native permission-request failure without throwing', async () => {
    requestPermission.mockRejectedValueOnce(new Error('native permission failure'));

    await expect(requestPhotoLibraryAccess(() => true)).resolves.toBe(false);
    expect(showDialog).toHaveBeenCalledWith(
      'Photos',
      'Photos access is unavailable. Try again or enable it in system settings.',
    );
  });

  it('does nothing when the screen is already retired', async () => {
    await expect(requestPhotoLibraryAccess(() => false)).resolves.toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('does not show an old screen dialog when the account retires during the request', async () => {
    let resolvePermission!: (value: { granted: boolean; status: string }) => void;
    requestPermission.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePermission = resolve)),
    );
    let current = true;
    const pending = requestPhotoLibraryAccess(() => current);
    current = false;
    resolvePermission({ granted: false, status: 'denied' });

    await expect(pending).resolves.toBe(false);
    expect(showDialog).not.toHaveBeenCalled();
  });
});
