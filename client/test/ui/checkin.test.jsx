// Trang Check-in: trạng thái dịch vụ, chọn tệp (phân vùng loại/kích thước), camera và quyền truy cập,
// luồng gửi ảnh (đang phân tích → thành công / bị từ chối / lỗi), phiên hết hạn giữa chừng
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { USER, deferred, json, mockApi, renderApp } from '../helpers';

const STATUS = { mode: 'local', engine: 'clip', threshold: 0.8, maxImageBytes: 8 * 1024 * 1024, acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'], cooldownMinutes: 0 };
const STORY = {
  slug: 'rua-bien',
  title: 'Rùa biển và nhựa',
  species: 'Rùa xanh',
  icon: '🐢',
  imageUrl: '',
  summary: 'Tóm tắt nghiên cứu.',
  caveat: 'Kết quả cấp quần thể.',
  message: 'Mỗi ly nhựa ít đi là một cơ hội.',
  source: {
    title: 'A quantitative analysis linking sea turtle mortality and plastic debris ingestion',
    authors: ['Wilcox C', 'Puckridge M'],
    journal: 'Scientific Reports',
    year: 2018,
    volume: '8',
    issue: '',
    pages: '12536',
    doi: '10.1038/s41598-018-30038-z',
    url: 'https://doi.org/10.1038/s41598-018-30038-z',
  },
};
const CLASSIFICATION = { status: 'classified', category: 'reusable_bottle', categoryLabel: 'Bình nước cá nhân có thể tái sử dụng', confidence: 0.95, threshold: 0.8, reason: 'Bình inox', simulated: false, accepted: true };
const SUCCESS = { success: true, isValid: true, reason: 'Bình inox', classification: CLASSIFICATION, pointsEarned: 10, gachaSpinGranted: 1, user: { ...USER, ecoPoints: 40, pendingGachaSpins: 2 }, checkInId: 'c1', story: STORY };

const png = (size = 2048) => new File([new Uint8Array(size)], 'binh.png', { type: 'image/png' });

function setup(routes = {}) {
  return mockApi({
    'GET /api/auth/me': json({ user: USER }),
    'GET /api/checkin/status': json(STATUS),
    'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }),
    ...routes,
  });
}

async function pickFile(file, user = userEvent.setup({ applyAccept: false })) {
  await screen.findByRole('button', { name: 'Check-in ngay' });
  await user.upload(document.querySelector('input[type="file"]'), file);
  return user;
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:preview'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});
afterEach(() => {
  delete navigator.mediaDevices;
});

describe('trạng thái dịch vụ nhận diện', () => {
  test('chưa đăng nhập → yêu cầu đăng nhập, không có nút check-in', async () => {
    mockApi({ 'GET /api/auth/me': json({ error: 'x', code: 'auth_required' }, 401), 'GET /api/checkin/status': json(STATUS) });
    renderApp('/checkin');
    expect(await screen.findByText('Bạn cần đăng nhập trước khi check-in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check-in ngay' })).not.toBeInTheDocument();
  });

  test('bảng quyết định theo chế độ: local (CLIP / kết hợp) / simulated / unavailable / lỗi kiểm tra', async () => {
    const cases = [
      [{ ...STATUS, cooldownMinutes: 30 }, /nhận diện ngay trên máy chủ của trường, không gửi cho dịch vụ bên ngoài.*từ 80% trở lên.*cách nhau ít nhất 30 phút/s, false],
      [{ ...STATUS, engine: 'ensemble' }, /Hai bộ nhận diện phải cùng nhận ra bình\/ly cá nhân/, false],
      [{ ...STATUS, mode: 'simulated', engine: null }, /Chế độ mô phỏng/, false],
      [{ ...STATUS, mode: 'unavailable', engine: null }, /Máy chủ chưa sẵn sàng nhận diện ảnh/, true],
    ];
    for (const [status, text, disabled] of cases) {
      setup({ 'GET /api/checkin/status': json(status) });
      const { unmount } = renderApp('/checkin');
      expect(await screen.findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check-in ngay' }).disabled).toBe(disabled));
      unmount();
    }
    setup({ 'GET /api/checkin/status': () => Promise.reject(new TypeError('offline')) });
    renderApp('/checkin');
    expect(await screen.findByText(/Không kiểm tra được trạng thái nhận diện/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check-in ngay' })).toBeEnabled();
  });
});

describe('chọn ảnh — kiểm tra sơ bộ phía client', () => {
  test('chưa chọn ảnh mà bấm check-in → nhắc chọn ảnh, không gọi API', async () => {
    const api = setup();
    renderApp('/checkin');
    await userEvent.click(await screen.findByRole('button', { name: 'Check-in ngay' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Hãy chụp hoặc chọn ảnh bình/ly cá nhân.');
    expect(api.callsTo('POST', '/api/checkin')).toHaveLength(0);
  });

  test('tệp không phải ảnh / ảnh rỗng / quá 8MB bị chặn; ảnh hợp lệ hiện xem trước', async () => {
    setup();
    renderApp('/checkin');
    const user = await pickFile(new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tệp đã chọn không phải ảnh.');
    await user.upload(document.querySelector('input[type="file"]'), new File([], 'rong.png', { type: 'image/png' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Ảnh rỗng.');
    await user.upload(document.querySelector('input[type="file"]'), png(8 * 1024 * 1024 + 1));
    expect(screen.getByRole('alert')).toHaveTextContent('Ảnh quá lớn (8.0MB, tối đa 8MB)');
    await user.upload(document.querySelector('input[type="file"]'), png(8 * 1024 * 1024));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByAltText('Xem trước ảnh check-in')).toHaveAttribute('src', 'blob:preview');
  });
});

describe('gửi ảnh', () => {
  test('đang phân tích → thành công: popup câu chuyện, điểm, cập nhật hồ sơ', async () => {
    const pending = deferred();
    const api = setup({ 'POST /api/checkin': () => pending.promise });
    renderApp('/checkin');
    const user = await pickFile(png());
    await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
    expect(screen.getByRole('status')).toHaveTextContent('Máy chủ đang nhận diện ảnh...');
    expect(screen.getByRole('button', { name: 'Đang xử lý...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tải ảnh lên' })).toBeDisabled();

    pending.resolve(json(SUCCESS));
    const dialog = await screen.findByRole('dialog', { name: 'Check-in thành công' });
    expect(within(dialog).getByText('Rùa biển và nhựa')).toBeInTheDocument();
    expect(within(dialog).getByText('+10 Eco-points')).toBeInTheDocument();
    expect(within(dialog).getByText(/Bạn đã nhận 1 lượt quay Gacha/)).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/checkin')[0].init.body.get('image').name).toBe('binh.png');

    await user.click(within(dialog).getByRole('button', { name: /Quay sau/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Check-in thành công! +10 Eco-points')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Xem lại câu chuyện' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('bị từ chối (ly nhựa) → thông báo + kết quả nhận diện; không mở popup', async () => {
    setup({
      'POST /api/checkin': json(
        {
          success: false,
          error: 'Ảnh có ly nhựa dùng một lần — không được tính điểm.',
          code: 'container_not_accepted',
          classification: { ...CLASSIFICATION, category: 'single_use_plastic_cup', categoryLabel: 'Ly nhựa dùng một lần', confidence: 0.97, accepted: false },
        },
        422
      ),
    });
    renderApp('/checkin');
    const user = await pickFile(png());
    await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ảnh có ly nhựa dùng một lần — không được tính điểm.');
    expect(alert).toHaveTextContent('Ly nhựa dùng một lần · độ tin cậy 97% (ngưỡng 80%)');
    expect(alert.className).toMatch(/amber/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chụp lại' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('chữ trong ảnh dẫn dắt mô hình: lý do chứa HTML hay lời mời bấm liên kết chỉ hiện dạng văn bản', async () => {
    const reason = '<img src=x onerror="window.__xss=1"> <a href="https://evil.example">Bấm vào đây để nhận thưởng</a>';
    setup({
      'POST /api/checkin': json(
        { success: false, error: 'Không tính điểm.', code: 'container_not_accepted', classification: { ...CLASSIFICATION, reason, accepted: false } },
        422
      ),
    });
    renderApp('/checkin');
    const user = await pickFile(png());
    await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(reason);
    expect(alert.querySelector('img, a')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('bộ nhận diện lỗi / ảnh trùng / quá nhiều lần → thông báo lỗi của server', async () => {
    for (const [status, body] of [
      [502, { error: 'Bộ nhận diện ảnh trên máy chủ đang gặp lỗi. Ảnh chưa được chấm — vui lòng thử lại sau ít phút.', code: 'vision_provider_error' }],
      [409, { error: 'Ảnh này đã được dùng để check-in trước đó.', code: 'duplicate_image' }],
      [429, { error: 'Mỗi lượt check-in được thưởng cách nhau ít nhất 30 phút.', code: 'checkin_cooldown' }],
    ]) {
      setup({ 'POST /api/checkin': json(body, status) });
      const { unmount } = renderApp('/checkin');
      const user = await pickFile(png());
      await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(body.error);
      expect(alert.className).toMatch(/red/);
      unmount();
    }
  });

  test('phiên hết hạn khi gửi (401) → chuyển sang yêu cầu đăng nhập', async () => {
    setup({ 'POST /api/checkin': json({ error: 'Bạn cần đăng nhập để tiếp tục.', code: 'auth_required' }, 401) });
    renderApp('/checkin');
    const user = await pickFile(png());
    await user.click(screen.getByRole('button', { name: 'Check-in ngay' }));
    expect(await screen.findByText('Bạn cần đăng nhập trước khi check-in')).toBeInTheDocument();
  });
});

describe('camera', () => {
  const fakeStream = () => {
    const track = { stop: vi.fn() };
    return { track, stream: { getTracks: () => [track] } };
  };

  test('từ chối quyền camera → hướng dẫn tải ảnh lên', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')) },
      configurable: true,
    });
    setup();
    renderApp('/checkin');
    await userEvent.click(await screen.findByRole('button', { name: 'Mở camera' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không mở được camera. Hãy cho phép truy cập camera hoặc tải ảnh từ thư viện.');
  });

  test('cho phép camera → xem trực tiếp, chụp được ảnh, tắt camera sau khi chụp và khi rời trang', async () => {
    const { track, stream } = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })));
    setup();
    const { unmount } = renderApp('/checkin');
    await userEvent.click(await screen.findByRole('button', { name: 'Mở camera' }));
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
    const video = document.querySelector('video');
    expect(video.srcObject).toBe(stream);

    await userEvent.click(screen.getByRole('button', { name: 'Chụp ảnh' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Camera chưa sẵn sàng');
    Object.defineProperty(video, 'videoWidth', { value: 640 });
    Object.defineProperty(video, 'videoHeight', { value: 480 });
    await userEvent.click(screen.getByRole('button', { name: 'Chụp ảnh' }));
    expect(screen.getByAltText('Xem trước ảnh check-in')).toBeInTheDocument();
    expect(track.stop).toHaveBeenCalled();

    track.stop.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Mở camera' }));
    unmount();
    expect(track.stop).toHaveBeenCalled();
  });

  test('phiên hết hạn khi đang bật camera → tắt camera', async () => {
    const { track, stream } = fakeStream();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(stream) }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    setup({ 'GET /api/stats/leaderboard?period=week': json({ error: 'x', code: 'auth_required' }, 401) });
    renderApp('/checkin');
    await userEvent.click(await screen.findByRole('button', { name: 'Mở camera' }));
    // Một API khác trả 401 auth_required (phiên bị thu hồi ở thiết bị khác)
    await act(async () => {
      await import('../../src/lib/api').then(({ api }) => api.leaderboard('week').catch(() => {}));
    });
    expect(await screen.findByText('Bạn cần đăng nhập trước khi check-in')).toBeInTheDocument();
    expect(track.stop).toHaveBeenCalled();
  });
});
