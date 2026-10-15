import React from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

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

function Harness({ path, refreshKey = 0 }: { path: string | null; refreshKey?: number }) {
  const protectedPath = useAttachmentCachePathProtection(path, refreshKey);
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

it('retries protection for the same path at once when the caller changes its refresh key', async () => {
  const path = 'file:///documents/attachments/recovered.jpg';
  mockProtect.mockReturnValueOnce(null);
  const view = await render(<Harness path={path} />);
  expect(view.getByTestId('protected-path').props.children).toBe('none');

  await view.rerender(<Harness path={path} refreshKey={1} />);
  expect(mockProtect).toHaveBeenCalledTimes(2);
  expect(view.getByTestId('protected-path').props.children).toBe(path);
  await view.unmount();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

it('retries a refused pin on its own until it lands, so a brief refusal leaves no blank bubble', async () => {
  jest.useFakeTimers();
  try {
    const path = 'file:///documents/attachments/briefly-retiring.jpg';
    mockProtect.mockReturnValueOnce(null).mockReturnValueOnce(null);
    const view = await render(<Harness path={path} />);
    expect(view.getByTestId('protected-path').props.children).toBe('none');

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockProtect).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('protected-path').props.children).toBe('none');

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockProtect).toHaveBeenCalledTimes(3);
    expect(view.getByTestId('protected-path').props.children).toBe(path);

    await view.unmount();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
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
  jest.useFakeTimers();
  try {
    mockProtect.mockImplementationOnce(() => {
      throw new RangeError('bad path');
    });
    const view = await render(<Harness path="file:///bad" />);

    expect(view.getByTestId('protected-path').props.children).toBe('none');
    // An untrusted path is refused for good; it is not retried on a timer.
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(mockProtect).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(mockRelease).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
