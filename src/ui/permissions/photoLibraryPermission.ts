import * as ImagePicker from 'expo-image-picker';
import { showDialog } from '../dialog/dialogStore';

const DENIED_COPY =
  'Permission denied. Enable Photos access in system settings to choose an image.';
const UNAVAILABLE_COPY = 'Photos access is unavailable. Try again or enable it in system settings.';

/** Request photo-library access for an explicit image-picking action. */
export async function requestPhotoLibraryAccess(isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!isCurrent()) return false;
    if (permission.granted) return true;
    showDialog('Photos', DENIED_COPY);
    return false;
  } catch {
    if (isCurrent()) showDialog('Photos', UNAVAILABLE_COPY);
    return false;
  }
}
