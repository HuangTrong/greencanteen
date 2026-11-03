// Popup sau check-in: câu chuyện nghiên cứu (nguồn đầy đủ / thiếu / URL không an toàn), ảnh minh họa, quay Gacha
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

  test('URL nguồn không an toàn (javascript:, http:) → không tạo liên kết', () => {
    for (const url of ['javascript:alert(1)', 'http://doi.org/10.1/x', 'data:text/html,<script>']) {
      const { unmount } = render(<CheckInSuccessModal open onClose={() => {}} story={story({}, { url })} pointsEarned={10} />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
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

  test('chế độ mô phỏng được gắn nhãn rõ; không có câu chuyện vẫn hiển thị điểm', () => {
    renderModal({ story: null, classification: { categoryLabel: 'Bình', simulated: true }, gachaSpinGranted: undefined });
    expect(screen.getByText('MÔ PHỎNG — không phải AI')).toBeInTheDocument();
    expect(screen.getByText('+10 Eco-points')).toBeInTheDocument();
    expect(screen.getByText(/Bạn đã nhận 1 lượt quay Gacha/)).toBeInTheDocument();
  });
});

describe('quay Gacha trong popup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  test('đang quay không đóng được; nhận mã nạp, báo số lượt còn lại; sao chép mã', async () => {
    mockApi({
      'POST /api/gacha/spin': json({ prize: { label: 'Mã nạp điện thoại', carrier: 'Viettel', amountVnd: 20000, topUpCode: 'GC-20K-ABCD1234' }, pendingGachaSpins: 0 }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Sau setup(): user-event tự gắn clipboard giả của nó vào navigator
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { onClose, onGachaComplete } = renderModal();

    await user.click(screen.getByRole('button', { name: /Quay Gacha/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Đang quay Gacha...');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1800));
    const dialog = await screen.findByRole('dialog', { name: 'Phần thưởng Gacha' });
    expect(within(dialog).getByText('20.000đ')).toBeInTheDocument();
    expect(within(dialog).getByText('GC-20K-ABCD1234')).toBeInTheDocument();
    expect(onGachaComplete).toHaveBeenCalledWith({ pendingGachaSpins: 0 });

    await user.click(screen.getByRole('button', { name: 'Sao chép mã' }));
    expect(writeText).toHaveBeenCalledWith('GC-20K-ABCD1234');
    expect(screen.getByRole('button', { name: 'Đã sao chép!' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('button', { name: 'Sao chép mã' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hoàn tất' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('hết lượt quay (400) → quay về câu chuyện kèm thông báo lỗi; sao chép bị chặn không làm sập', async () => {
    mockApi({ 'POST /api/gacha/spin': json({ error: 'Bạn chưa có lượt quay Gacha.', code: 'no_spins' }, 400) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderModal();
    await user.click(screen.getByRole('button', { name: /Quay Gacha/ }));
    await act(() => vi.advanceTimersByTimeAsync(1800));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn chưa có lượt quay Gacha.');
    expect(screen.getByRole('button', { name: /Quay Gacha/ })).toBeInTheDocument();
  });
});
