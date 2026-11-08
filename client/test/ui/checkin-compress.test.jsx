// Trang Check-in nén ảnh trước khi gửi (lib/imageCompress): giới hạn kích thước áp cho ảnh đã nén, gửi đúng tệp đã nén, chọn ảnh mới khi
// ảnh trước còn đang nén thì chỉ giữ ảnh mới, ảnh chụp từ camera được thu nhỏ về cạnh dài tối đa 2048 px.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { USER, deferred, json, mockApi, renderApp } from '../helpers';

const prepareUpload = vi.fn();
vi.mock('../../src/lib/imageCompress', async (importOriginal) => ({ ...(await importOriginal()), prepareUpload: (...args) => prepareUpload(...args) }));

const STATUS = { mode: 'local', engine: 'classifier', threshold: 0.95, maxImageBytes: 8 * 1024 * 1024, acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'], cooldownMinutes: 0, dailyMax: 3 };
const SUCCESS = {
  success: true,
  isValid: true,
  reason: 'Bình inox',
  classification: { status: 'classified', category: 'reusable_bottle', confidence: 0.99, threshold: 0.95, accepted: true },
  pointsEarned: 10,
  gachaSpinGranted: 1,
  user: USER,
  checkInId: 'c1',
  story: null,
};
const bytesFile = (bytes, name, type = 'image/jpeg') => new File([new Uint8Array(bytes)], name, { type });

function setup(routes = {}) {
  return mockApi({
    'GET /api/auth/me': json({ user: USER }),
    'GET /api/checkin/status': json(STATUS),
    'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }),
    ...routes,
  });
}

async function pick(file, user = userEvent.setup({ applyAccept: false })) {
  await screen.findByRole('button', { name: 'Check-in ngay' });
  await user.upload(document.querySelector('input[type="file"]'), file);
  return user;
}

beforeEach(() => {
  prepareUpload.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:preview'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});
afterEach(() => {
  delete navigator.mediaDevices;
  vi.restoreAllMocks();
});

describe('nén ảnh chọn từ thư viện trước khi gửi', () => {
  test('ảnh gốc 12 MB nén còn 0,6 MB → không báo quá lớn, gửi đúng tệp đã nén', async () => {
    const original = bytesFile(12 * 1024 * 1024, 'IMG_0001.jpg');
    const compressed = bytesFile(600_000, 'IMG_0001.jpg');
    prepareUpload.mockResolvedValue({ file: compressed, compressed: true, originalBytes: original.size });
    const api = setup({ 'POST /api/checkin': json(SUCCESS) });
    renderApp('/checkin');
    const user = await pick(original);
    expect(prepareUpload).toHaveBeenCalledWith(original);
    expect(await screen.findByAltText('Xem trước ảnh check-in')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
    await screen.findByRole('dialog', { name: 'Check-in thành công' });
    expect(api.callsTo('POST', '/api/checkin')[0].init.body.get('image').size).toBe(600_000);
  });

  test('không nén được mà tệp vẫn quá giới hạn → báo quá lớn như cũ, không có ảnh để gửi', async () => {
    const original = bytesFile(9 * 1024 * 1024, 'hong.jpg');
    prepareUpload.mockResolvedValue({ file: original, compressed: false });
    setup();
    renderApp('/checkin');
    await pick(original);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ảnh quá lớn (9.0MB, tối đa 8MB)');
    expect(screen.queryByAltText('Xem trước ảnh check-in')).not.toBeInTheDocument();
  });

  test('tệp không phải ảnh bị chặn ngay, không giải mã', async () => {
    setup();
    renderApp('/checkin');
    await pick(new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tệp đã chọn không phải ảnh.');
    expect(prepareUpload).not.toHaveBeenCalled();
  });

  test('đang nén thì nút check-in chờ; chọn ảnh khác khi ảnh trước chưa nén xong → chỉ giữ ảnh chọn sau', async () => {
    const first = deferred();
    const second = deferred();
    prepareUpload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = setup({ 'POST /api/checkin': json(SUCCESS) });
    renderApp('/checkin');
    const user = await pick(bytesFile(5_000_000, 'cu.jpg'));
    expect(screen.getByRole('button', { name: 'Đang chuẩn bị ảnh...' })).toBeDisabled();
    await user.upload(document.querySelector('input[type="file"]'), bytesFile(5_000_000, 'moi.jpg'));
    second.resolve({ file: bytesFile(400_000, 'moi.jpg'), compressed: true });
    first.resolve({ file: bytesFile(300_000, 'cu.jpg'), compressed: true });
    const button = await screen.findByRole('button', { name: 'Check-in ngay' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole('dialog', { name: 'Check-in thành công' });
    expect(api.callsTo('POST', '/api/checkin')[0].init.body.get('image').name).toBe('moi.jpg');
  });
});

describe('ảnh chụp từ camera', () => {
  test('khung hình 3840×2160 được thu nhỏ về 2048×1152 và nén JPEG chất lượng 0,85', async () => {
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect: vi.fn() });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlobStub(cb) {
      cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
    });
    setup();
    renderApp('/checkin');
    await userEvent.click(await screen.findByRole('button', { name: 'Mở camera' }));
    const video = document.querySelector('video');
    Object.defineProperty(video, 'videoWidth', { value: 3840 });
    Object.defineProperty(video, 'videoHeight', { value: 2160 });
    await userEvent.click(screen.getByRole('button', { name: 'Chụp ảnh' }));
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 2048, 1152);
    const canvas = toBlob.mock.instances[0];
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
    expect(toBlob.mock.calls[0].slice(1)).toEqual(['image/jpeg', 0.85]);
    expect(await screen.findByAltText('Xem trước ảnh check-in')).toBeInTheDocument();
  });
});
