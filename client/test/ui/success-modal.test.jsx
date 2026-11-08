// Popup sau check-in: câu chuyện nghiên cứu (nguồn đầy đủ / thiếu / URL không an toàn), ảnh minh họa, quay thưởng tri ân
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import CheckInSuccessModal from '../../src/components/CheckInSuccessModal';
import { json, mockApi } from '../helpers';

const SOURCE = {
  title: 'Plastic debris ingestion by seabirds',
  authors: ['Roman L', 'Hardesty BD'],
  journal: 'Scientific Reports',
  year: 2019,
  volume: '9',
  issue: '1',
  pages: '3202',
  doi: '10.1038/s41598-018-36585-9',
  url: 'https://doi.org/10.1038/s41598-018-36585-9',
};
const story = (overrides = {}, source = {}) => ({
  slug: 's',
  title: 'Chim biển',
  species: 'Hải âu',
  icon: '🐦',
  imageUrl: '',
  summary: 'Tóm tắt.',
  caveat: '',
  message: 'Thông điệp.',
  source: { ...SOURCE, ...source },
  ...overrides,
});

function renderModal(props = {}) {
  const onClose = vi.fn();
  const onGachaComplete = vi.fn();
  const view = render(
    <CheckInSuccessModal
      open
      onClose={onClose}
      story={story()}
      classification={{ categoryLabel: 'Ly/cốc cá nhân có thể tái sử dụng', confidence: 0.9, simulated: false }}
      pointsEarned={10}
      gachaSpinGranted={1}
      onGachaComplete={onGachaComplete}
      {...props}
    />
  );
  return { ...view, onClose, onGachaComplete };
}

describe('câu chuyện và nguồn nghiên cứu', () => {
  test('nguồn đầy đủ: tác giả, tạp chí (năm), tập(số): trang, liên kết DOI mở tab mới an toàn', () => {
    renderModal();
    expect(screen.getByText('Roman L, Hardesty BD')).toBeInTheDocument();
    expect(screen.getByText('Scientific Reports').tagName).toBe('SPAN');
    expect(screen.getByText(/\(2019\), 9\(1\): 3202/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /DOI: 10\.1038\/s41598-018-36585-9/ });
    expect(link).toHaveAttribute('href', SOURCE.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('AI nhận diện:')).toBeInTheDocument();
    expect(screen.getByText(/· độ tin cậy 90%/)).toBeInTheDocument();
  });

  test('URL nguồn không an toàn (javascript:, http:) → không tạo liên kết; chỉ còn liên kết tới thể lệ quay thưởng', () => {
    for (const url of ['javascript:alert(1)', 'http://doi.org/10.1/x', 'data:text/html,<script>']) {
      const { unmount } = render(<CheckInSuccessModal open onClose={() => {}} story={story({}, { url })} pointsEarned={10} />);
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/gacha-rules.html']);
      unmount();
    }
  });

  test('không có DOI → chữ "Mở bài báo"', () => {
    renderModal({ story: story({}, { doi: '' }) });
    expect(screen.getByRole('link', { name: /Mở bài báo/ })).toBeInTheDocument();
  });

  test('nguồn thiếu tạp chí, năm, tác giả → không sập, không hiện "()" hay dòng trống', () => {
    const { container } = render(
      <CheckInSuccessModal
        open
        onClose={() => {}}
        story={story({}, { journal: undefined, year: undefined, authors: undefined, volume: '', issue: '', pages: '' })}
        pointsEarned={10}
      />
    );
    expect(screen.getByText(SOURCE.title)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\(\)/);
    expect(screen.getByRole('link', { name: /DOI/ })).toBeInTheDocument();
  });

  test('ảnh minh họa: https hiển thị, lỗi tải → biểu tượng; URL không an toàn → biểu tượng', () => {
    const { unmount } = renderModal({ story: story({ imageUrl: 'https://cdn.example/rua.jpg' }) });
    const img = document.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://cdn.example/rua.jpg');
    fireEvent.error(img);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('🐦')).toBeInTheDocument();
    unmount();
    renderModal({ story: story({ imageUrl: 'javascript:alert(1)' }) });
    expect(document.querySelector('img')).toBeNull();
  });

  // SEC-04: dữ liệu cũ trong DB còn URL trỏ vào mạng nội bộ thì trình duyệt của sinh viên cũng không được gửi request tới đó
  test.each([
    'https://192.168.1.1/anh.jpg',
    'https://10.0.0.5/anh.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1:8443/anh.jpg',
    'https://[::1]/anh.jpg',
    'https://localhost/anh.jpg',
    'https://may-in/anh.jpg',
    'https://camera.local/anh.jpg',
    'https://nguoi:mat-khau@cdn.example/anh.jpg',
    'https://cdn.example:8443/anh.jpg',
  ])('SEC-04: ảnh câu chuyện trỏ vào %s → không tải, dùng biểu tượng', (imageUrl) => {
    renderModal({ story: story({ imageUrl }) });
    expect(document.querySelector('img')).toBeNull();
  });

  test('chế độ mô phỏng được gắn nhãn rõ; không có câu chuyện vẫn hiển thị điểm', () => {
    renderModal({ story: null, classification: { categoryLabel: 'Bình', simulated: true }, gachaSpinGranted: undefined });
    expect(screen.getByText('MÔ PHỎNG — không phải AI')).toBeInTheDocument();
    expect(screen.getByText('+10 Eco-points')).toBeInTheDocument();
    expect(screen.getByText(/Bạn nhận được 1 lượt quay thưởng tri ân/)).toBeInTheDocument();
  });
});

describe('quay thưởng tri ân trong popup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  const WIN = {
    outcome: 'win',
    prize: { type: 'keychain', label: 'Lá xanh', description: 'Móc khóa hình lá', imageUrl: '/api/gacha/media/abc', claimCode: 'TA-ABCDE-23456' },
    claimInstructions: 'Nhận ở quầy căn tin tầng 1',
    sticker: { url: '/api/gacha/media/sticker', name: 'Pháo hoa' },
    pendingGachaSpins: 0,
    rewardId: 'r1',
  };

  test('đang quay không đóng được; trúng: sticker, ảnh móc khóa, mã nhận quà, cách nhận; sao chép mã', async () => {
    mockApi({ 'POST /api/gacha/draw': json(WIN) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Sau setup(): user-event tự gắn clipboard giả của nó vào navigator
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { onClose, onGachaComplete } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Quay thưởng tri ân' }));
    expect(screen.getByRole('status')).toHaveTextContent('Đang quay thưởng...');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1800));
    const dialog = await screen.findByRole('dialog', { name: 'Kết quả quay thưởng' });
    expect(within(dialog).getByRole('heading', { name: 'Trúng thưởng!' })).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'Móc khóa Lá xanh' })).toHaveAttribute('src', '/api/gacha/media/abc');
    expect(dialog.querySelector('img[src="/api/gacha/media/sticker"]')).toHaveAttribute('alt', '');
    expect(within(dialog).getByText('TA-ABCDE-23456')).toBeInTheDocument();
    expect(within(dialog).getByText('Nhận ở quầy căn tin tầng 1')).toBeInTheDocument();
    expect(onGachaComplete).toHaveBeenCalledWith({ pendingGachaSpins: 0 });
    expect(within(dialog).queryByRole('button', { name: /Quay tiếp/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sao chép mã' }));
    expect(writeText).toHaveBeenCalledWith('TA-ABCDE-23456');
    expect(screen.getByRole('button', { name: 'Đã sao chép!' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('button', { name: 'Sao chép mã' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hoàn tất' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('không trúng: lời động viên, không có mã; còn lượt thì quay tiếp ngay trong popup', async () => {
    let calls = 0;
    mockApi({
      'POST /api/gacha/draw': () => {
        calls += 1;
        return calls === 1 ? json({ outcome: 'lose', prize: null, claimInstructions: '', sticker: null, pendingGachaSpins: 1, rewardId: 'r1' }) : json({ ...WIN, sticker: null });
      },
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderModal({ gachaSpinGranted: 1 });
    await user.click(screen.getByRole('button', { name: 'Quay thưởng tri ân' }));
    await act(() => vi.advanceTimersByTimeAsync(1800));
    expect(await screen.findByRole('heading', { name: 'Chưa trúng lần này' })).toBeInTheDocument();
    expect(screen.queryByText(/^TA-/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Quay tiếp (còn 1 lượt)' }));
    await act(() => vi.advanceTimersByTimeAsync(1800));
    expect(await screen.findByRole('heading', { name: 'Trúng thưởng!' })).toBeInTheDocument();
    expect(screen.getByText('🎉')).toBeInTheDocument();
  });

  test('ảnh móc khóa lỗi tải → biểu tượng thay thế có tên móc khóa', async () => {
    mockApi({ 'POST /api/gacha/draw': json(WIN) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderModal();
    await user.click(screen.getByRole('button', { name: 'Quay thưởng tri ân' }));
    await act(() => vi.advanceTimersByTimeAsync(1800));
    const image = await screen.findByRole('img', { name: 'Móc khóa Lá xanh' });
    fireEvent.error(image);
    expect(screen.getByRole('img', { name: 'Móc khóa Lá xanh' }).tagName).toBe('SPAN');
  });

  test('hết lượt quay (400) → quay về câu chuyện kèm thông báo lỗi', async () => {
    mockApi({ 'POST /api/gacha/draw': json({ error: 'Bạn chưa có lượt quay thưởng tri ân.', code: 'no_spins' }, 400) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderModal();
    await user.click(screen.getByRole('button', { name: 'Quay thưởng tri ân' }));
    await act(() => vi.advanceTimersByTimeAsync(1800));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn chưa có lượt quay thưởng tri ân.');
    expect(screen.getByRole('button', { name: 'Quay thưởng tri ân' })).toBeInTheDocument();
  });
});
