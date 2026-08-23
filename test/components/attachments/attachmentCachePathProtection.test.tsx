import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

const mockRelease = jest.fn();
const mockProtect = jest.fn<{ path: string; release: () => void } | null, [string]>(() => ({
  path: 'unused',
  release: mockRelease,
}));

jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => mockProtect(path) },
}));

// eslint-disable-next-line import/first
import { useAttachmentCachePathProtection } from '@ui/attachments/useAttachmentCachePathProtection';

function Harness({ path }: { path: string | null }): React.JSX.Element | null {
  const protectedPath = useAttachmentCachePathProtection(path);
  return <Text testID="protected-path">{protectedPath ?? 'none'}</Text>;
}

beforeEach(() => {
  mockProtect.mockClear();
  mockRelease.mockClear();
  mockProtect.mockReturnValue({ path: 'unused', release: mockRelease });
});

it('pins a mounted path, transfers the pin on path change, and releases it on unmount', async () => {
  const view = await render(<Harness path="file:///documents/attachments/a.jpg" />);
  expect(mockProtect).toHaveBeenCalledWith('file:///documents/attachments/a.jpg');
  expect(mockRelease).not.toHaveBeenCalled();
  expect(view.getByTestId('protected-path').props.children).toBe(
    'file:///documents/attachments/a.jpg',
  );

  await view.rerender(<Harness path="file:///documents/attachments/b.jpg" />);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockProtect).toHaveBeenLastCalledWith('file:///documents/attachments/b.jpg');
  expect(view.getByTestId('protected-path').props.children).toBe(
    'file:///documents/attachments/b.jpg',
  );

  await view.unmount();
  expect(mockRelease).toHaveBeenCalledTimes(2);
});

it('does not allocate a protection for a missing path', async () => {
  const view = await render(<Harness path={null} />);
  expect(mockProtect).not.toHaveBeenCalled();
  await view.unmount();
  expect(mockRelease).not.toHaveBeenCalled();
});

it('fails closed when retirement already owns the local path', async () => {
  mockProtect.mockReturnValueOnce(null);
  const view = await render(<Harness path="file:///documents/attachments/retiring.jpg" />);

  expect(mockProtect).toHaveBeenCalledWith('file:///documents/attachments/retiring.jpg');
  expect(view.getByTestId('protected-path').props.children).toBe('none');
  await view.unmount();
  expect(mockRelease).not.toHaveBeenCalled();
});

it('passes a remote URL through without allocating a cache protection', async () => {
  const view = await render(<Harness path="https://dev.local/attachment.jpg" />);

  expect(view.getByTestId('protected-path').props.children).toBe(
    'https://dev.local/attachment.jpg',
  );
  expect(mockProtect).not.toHaveBeenCalled();
  await view.unmount();
});

it('fails closed instead of crashing when protect rejects a malformed path', async () => {
  mockProtect.mockImplementationOnce(() => {
    throw new RangeError('bad path');
  });
  const view = await render(<Harness path="file:///bad" />);

  expect(view.getByTestId('protected-path').props.children).toBe('none');
  await view.unmount();
  expect(mockRelease).not.toHaveBeenCalled();
});
