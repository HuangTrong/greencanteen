// Nén ảnh check-in phía client trước khi gửi: thu nhỏ cạnh dài về tối đa 2048 px và nén JPEG khi ảnh lớn, để qua được proxy của nơi
// đặt giao diện (Vercel / Render rewrite) có giới hạn kích thước request. Giải mã / mã hóa thật cần trình duyệt (kiểm ở E2E); ở đây
// thay bằng hàm giả để kiểm quy tắc: khi nào nén, kích thước đích, giữ nguyên tệp gốc khi không nén được.
import { describe, expect, test, vi } from 'vitest';
import { JPEG_QUALITY, MAX_SIDE, prepareUpload, targetSize } from '../../src/lib/imageCompress';

const fileOf = (bytes, name = 'binh.png', type = 'image/png') => new File([new Uint8Array(bytes)], name, { type });
const fakeDecode = (width, height) => {
  const close = vi.fn();
  return { decode: vi.fn(async () => ({ width, height, source: 'ảnh-đã-giải-mã', close })), close };
};
const fakeEncode = (bytes = 300_000) => vi.fn(async () => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));

describe('targetSize — cạnh dài tối đa 2048 px, giữ tỉ lệ, không phóng to', () => {
  test.each([
    [4000, 3000, 2048, 1536],
    [3000, 4000, 1536, 2048],
    [2048, 1000, 2048, 1000],
    [1000, 800, 1000, 800],
    [8000, 1, 2048, 1],
  ])('%i×%i → %i×%i', (w, h, ew, eh) => {
    expect(targetSize(w, h)).toMatchObject({ width: ew, height: eh });
  });
  test('hằng số dùng cho ảnh gửi đi', () => {
    expect(MAX_SIDE).toBe(2048);
    expect(JPEG_QUALITY).toBe(0.85);
  });
});

describe('prepareUpload', () => {
  test('ảnh lớn hơn 2048 px → nén JPEG đúng kích thước đích, đổi đuôi tên thành .jpg, giải phóng ảnh đã giải mã', async () => {
    const { decode, close } = fakeDecode(4000, 3000);
    const encode = fakeEncode();
    const result = await prepareUpload(fileOf(9_000_000, 'IMG_0001.png'), { decode, encode });
    expect(encode).toHaveBeenCalledWith('ảnh-đã-giải-mã', 2048, 1536, JPEG_QUALITY);
    expect(result.compressed).toBe(true);
    expect(result.file.name).toBe('IMG_0001.jpg');
    expect(result.file.type).toBe('image/jpeg');
    expect(result.file.size).toBe(300_000);
    expect(result.originalBytes).toBe(9_000_000);
    expect(close).toHaveBeenCalled();
  });

  test('kích thước trong giới hạn nhưng tệp nặng hơn 1,5 MB → vẫn nén (cùng kích thước)', async () => {
    const { decode } = fakeDecode(2000, 1500);
    const encode = fakeEncode(400_000);
    const result = await prepareUpload(fileOf(3_000_000, 'anh.jpg', 'image/jpeg'), { decode, encode });
    expect(encode).toHaveBeenCalledWith('ảnh-đã-giải-mã', 2000, 1500, JPEG_QUALITY);
    expect(result.compressed).toBe(true);
  });

  test('ảnh nhỏ, nhẹ, định dạng máy chủ nhận → gửi nguyên tệp, không mã hóa lại', async () => {
    const { decode } = fakeDecode(1200, 900);
    const encode = fakeEncode();
    const original = fileOf(800_000, 'nho.jpg', 'image/jpeg');
    const result = await prepareUpload(original, { decode, encode });
    expect(encode).not.toHaveBeenCalled();
    expect(result).toEqual({ file: original, compressed: false });
  });

  test('định dạng máy chủ không nhận (HEIC) nhưng trình duyệt giải mã được → luôn chuyển sang JPEG', async () => {
    const { decode } = fakeDecode(1200, 900);
    const encode = fakeEncode();
    const result = await prepareUpload(fileOf(500_000, 'IMG_2.HEIC', 'image/heic'), { decode, encode });
    expect(encode).toHaveBeenCalled();
    expect(result.file.name).toBe('IMG_2.jpg');
    expect(result.file.type).toBe('image/jpeg');
  });

  test('nén xong không nhẹ hơn ảnh gốc (đã trong giới hạn) → giữ ảnh gốc', async () => {
    const { decode } = fakeDecode(1600, 1200);
    const original = fileOf(1_600_000, 'a.webp', 'image/webp');
    const result = await prepareUpload(original, { decode, encode: fakeEncode(2_000_000) });
    expect(result).toEqual({ file: original, compressed: false });
  });

  test('không giải mã được / mã hóa lỗi → giữ tệp gốc để máy chủ kiểm tra và báo lỗi như cũ', async () => {
    const original = fileOf(9_000_000);
    const broken = await prepareUpload(original, { decode: vi.fn(async () => { throw new Error('không đọc được'); }), encode: fakeEncode() });
    expect(broken).toEqual({ file: original, compressed: false });
    const { decode, close } = fakeDecode(4000, 3000);
    const failing = await prepareUpload(original, { decode, encode: vi.fn(async () => { throw new Error('canvas lỗi'); }) });
    expect(failing).toEqual({ file: original, compressed: false });
    expect(close).toHaveBeenCalled();
    const empty = await prepareUpload(original, { decode: fakeDecode(4000, 3000).decode, encode: vi.fn(async () => null) });
    expect(empty).toEqual({ file: original, compressed: false });
  });

  test('tệp quá nặng để giải mã an toàn trên điện thoại hoặc tệp rỗng → không giải mã, giữ nguyên', async () => {
    const decode = vi.fn();
    const huge = fileOf(1, 'lon.jpg', 'image/jpeg');
    Object.defineProperty(huge, 'size', { value: 41 * 1024 * 1024 });
    expect(await prepareUpload(huge, { decode, encode: fakeEncode() })).toEqual({ file: huge, compressed: false });
    const empty = fileOf(0);
    expect(await prepareUpload(empty, { decode, encode: fakeEncode() })).toEqual({ file: empty, compressed: false });
    expect(decode).not.toHaveBeenCalled();
  });
});
