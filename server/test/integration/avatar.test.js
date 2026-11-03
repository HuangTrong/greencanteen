// Ảnh đại diện: chuẩn hóa ảnh, bỏ metadata, phân quyền, thay / gỡ, đồng thời, tệp sai, hiển thị trên bảng xếp hạng
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { UserAvatar } from '../../src/models/UserAvatar.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer, uniquePng } from '../helpers.js';

let ctx;

const SIMULATION = { VISION_SIMULATION: 'true' };
const AVATAR_URL = /^\/api\/avatars\/[\w-]{22}$/;

const canvas = (width, height, background = '#2f855a') => sharp({ create: { width, height, channels: 3, background } });
const photo = (width = 640, height = 480, background) => canvas(width, height, background).jpeg().toBuffer();
const upload = (client, buffer, options) => client.put('/api/avatars/me', { form: imageForm(buffer, options) });

async function student(overrides) {
  const client = createClient(ctx.base);
  const res = await registerUser(client, overrides);
  return { client, id: res.data.user.id };
}

async function fetchImage(url) {
  const res = await realFetch(ctx.base + url);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  setEnv(SIMULATION);
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(SIMULATION);
  await RateLimit.deleteMany({});
});

describe('đặt ảnh', () => {
  test('mọi ảnh được chuẩn hóa thành WebP vuông 256×256; URL công khai không lộ id tài khoản', async () => {
    const { client, id } = await student();
    assert.equal((await client.get('/api/auth/me')).data.user.avatarUrl, null);

    const res = await upload(client, await photo(), { type: 'image/jpeg', name: 'chan-dung.jpg' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const { avatarUrl } = res.data.user;
    assert.match(avatarUrl, AVATAR_URL);
    assert.ok(!avatarUrl.includes(id));

    const { res: image, body } = await fetchImage(avatarUrl);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    const { format, width, height } = await sharp(body).metadata();
    assert.deepEqual([format, width, height], ['webp', 256, 256]);

    const me = (await client.get('/api/auth/me')).data.user;
    assert.equal(me.avatarUrl, avatarUrl);
    assert.ok(!('avatarId' in me));
  });

  test('nhận JPEG, PNG, WebP; ảnh nhỏ được phóng lên, ảnh lớn được thu nhỏ', async () => {
    const { client } = await student();
    for (const [buffer, type] of [
      [await canvas(40, 30).png().toBuffer(), 'image/png'],
      [await canvas(4000, 3000).webp().toBuffer(), 'image/webp'],
      [await photo(3000, 4000), 'image/jpeg'],
    ]) {
      const res = await upload(client, buffer, { type });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      const { width, height } = await sharp((await fetchImage(res.data.user.avatarUrl)).body).metadata();
      assert.deepEqual([width, height], [256, 256]);
    }
  });

  test('EXIF (vị trí GPS, bản quyền) bị bỏ; ảnh chụp dọc xoay đúng chiều; dữ liệu chèn thêm vào tệp không đi theo', async () => {
    const { client } = await student();
    // Nửa trái đỏ, nửa phải xanh, cờ EXIF "xoay 90°": hiển thị đúng phải là nửa trên đỏ, nửa dưới xanh
    const source = await canvas(200, 200, '#ff0000')
      .composite([{ input: { create: { width: 100, height: 200, channels: 3, background: '#0000ff' } }, left: 100, top: 0 }])
      .withExif({ IFD0: { Copyright: 'BI-MAT-EXIF' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 30/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();
    assert.ok(source.includes('BI-MAT-EXIF'), 'ảnh gốc có EXIF');
    const tampered = Buffer.concat([source, Buffer.from('<script>alert(1)</script>')]);

    const res = await upload(client, tampered, { type: 'image/jpeg' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const { body } = await fetchImage(res.data.user.avatarUrl);
    assert.ok(!body.includes('BI-MAT-EXIF'));
    assert.ok(!body.includes('<script>'));
    const metadata = await sharp(body).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.orientation, undefined);

    const { data, info } = await sharp(body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    const [topRed, , topBlue] = pixel(128, 20);
    const [bottomRed, , bottomBlue] = pixel(128, 235);
    assert.ok(topRed > 200 && topBlue < 60, `phía trên phải đỏ: ${pixel(128, 20)}`);
    assert.ok(bottomBlue > 200 && bottomRed < 60, `phía dưới phải xanh: ${pixel(128, 235)}`);
  });
});

describe('thay và gỡ ảnh', () => {
  test('thay ảnh: URL cũ hết tác dụng, DB chỉ còn một bản', async () => {
    const { client, id } = await student();
    const first = (await upload(client, await photo())).data.user.avatarUrl;
    const second = (await upload(client, await photo(640, 480, '#c05621'))).data.user.avatarUrl;
    assert.notEqual(first, second);
    assert.equal((await fetchImage(first)).res.status, 404);
    assert.equal((await fetchImage(second)).res.status, 200);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 1);
  });

  test('gỡ ảnh: xóa khỏi DB, URL hết tác dụng; gỡ khi chưa có ảnh vẫn thành công', async () => {
    const { client, id } = await student();
    const { avatarUrl } = (await upload(client, await photo())).data.user;
    const removed = await client.del('/api/avatars/me');
    assert.equal(removed.status, 200);
    assert.equal(removed.data.user.avatarUrl, null);
    assert.equal((await fetchImage(avatarUrl)).res.status, 404);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 0);
    assert.equal((await User.findById(id).lean()).avatarId, undefined);
    assert.equal((await client.del('/api/avatars/me')).status, 200);
  });

  test('nhiều lần đổi ảnh đồng thời: tài khoản luôn trỏ tới ảnh còn tồn tại, không để lại bản thừa', async () => {
    const { client, id } = await student();
    const colors = ['#2f855a', '#c05621', '#2b6cb0', '#b7791f'];
    const images = await Promise.all(colors.map((color) => photo(320, 240, color)));
    const results = await Promise.all(images.map((image) => upload(client, image)));
    assert.ok(results.every((res) => res.status === 200));
    const me = (await client.get('/api/auth/me')).data.user;
    assert.equal((await fetchImage(me.avatarUrl)).res.status, 200);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 1);
  });

  test('ảnh của người này không bị yêu cầu của người khác đụng tới', async () => {
    const [owner, other] = [await student(), await student()];
    const { avatarUrl } = (await upload(owner.client, await photo())).data.user;
    await upload(other.client, await photo());
    await other.client.del('/api/avatars/me');
    assert.equal((await fetchImage(avatarUrl)).res.status, 200);
  });
});

describe('truy cập', () => {
  test('xem ảnh không cần đăng nhập, được cache; phản hồi ghi và lỗi thì không', async () => {
    const { client } = await student();
    const res = await upload(client, await photo());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { res: image, body } = await fetchImage(res.data.user.avatarUrl);
    assert.equal(image.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('content-length'), String(body.length));
    assert.ok(image.headers.get('etag'));

    for (const bad of ['khong-ton-tai', 'a'.repeat(22), `${'a'.repeat(21)}%2F`, 'me']) {
      const missing = await realFetch(`${ctx.base}/api/avatars/${bad}`);
      assert.equal(missing.status, 404, bad);
      assert.equal(missing.headers.get('cache-control'), 'no-store', bad);
    }
  });

  test('chưa đăng nhập 401; thiếu header chống CSRF 403; tài khoản bị khóa 401; không có gì được ghi', async () => {
    const image = await photo();
    const guest = createClient(ctx.base);
    assert.equal((await upload(guest, image)).status, 401);
    assert.equal((await guest.del('/api/avatars/me')).status, 401);

    const { client, id } = await student();
    assert.equal((await client.put('/api/avatars/me', { form: imageForm(image), csrf: false })).status, 403);
    assert.equal((await client.del('/api/avatars/me', { csrf: false })).status, 403);
    await User.updateOne({ _id: id }, { $set: { status: 'locked' } });
    assert.equal((await upload(client, image)).status, 401);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 0);
  });

  test('không đổi được ảnh của người khác bằng tham số gửi kèm', async () => {
    const [owner, attacker] = [await student(), await student()];
    const form = imageForm(await photo(), { extra: { userId: owner.id, studentId: 'x' } });
    await attacker.client.put(`/api/avatars/me?userId=${owner.id}`, { form });
    assert.equal(await UserAvatar.countDocuments({ userId: owner.id }), 0);
  });

  test('tối đa 20 lần đổi ảnh mỗi giờ theo tài khoản', async () => {
    const { client, id } = await student();
    await RateLimit.create({ key: `avatar-change:${id}`, count: 20, resetAt: new Date(Date.now() + 60_000) });
    const res = await upload(client, await photo());
    assert.deepEqual([res.status, res.data.code], [429, 'too_many_attempts']);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 0);
  });
});

describe('tệp không hợp lệ', () => {
  const expectRejected = async (client, id, send, status, code) => {
    const res = await send();
    assert.equal(res.status, status, JSON.stringify(res.data));
    assert.equal(res.data.code, code);
    assert.ok(res.data.error);
    assert.equal(await UserAvatar.countDocuments({ userId: id }), 0);
  };

  test('không phải ảnh, SVG, HEIC, tệp rỗng, ảnh cụt, ảnh hỏng đều bị từ chối theo nội dung, không theo tên tệp', async () => {
    const { client, id } = await student();
    const valid = await photo();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
    const cases = [
      [Buffer.from('MZ không phải ảnh'), 'image/png', 'gia.png', 415, 'image_type_unsupported'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'anh.svg', 415, 'image_type_unsupported'],
      [heic, 'image/heic', 'iphone.heic', 415, 'image_type_unsupported'],
      [Buffer.alloc(0), 'image/png', 'rong.png', 400, 'image_empty'],
      [valid.subarray(0, valid.length / 2), 'image/jpeg', 'cut.jpg', 400, 'image_unreadable'],
      [corrupt, 'image/jpeg', 'hong.jpg', 400, 'image_unreadable'],
    ];
    const original = console.error;
    console.error = () => {};
    try {
      for (const [buffer, type, name, status, code] of cases) {
        await expectRejected(client, id, () => upload(client, buffer, { type, name }), status, code);
      }
    } finally {
      console.error = original;
    }
  });

  test('thông báo HEIC dành riêng cho ảnh đại diện, không nhắc tới check-in', async () => {
    const { client } = await student();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    const { data } = await upload(client, heic, { type: 'image/heic', name: 'iphone.heic' });
    assert.match(data.error, /JPEG, PNG hoặc WebP/);
    assert.doesNotMatch(data.error, /camera|nhận diện/i);
  });

  test('quá 8 MB bị chặn; đúng 8 MB vẫn được nhận', async () => {
    const { client, id } = await student();
    const limit = 8 * 1024 * 1024;
    const padded = async (size) => {
      const png = await canvas(32, 32).png().toBuffer();
      return Buffer.concat([png, Buffer.alloc(size - png.length)]);
    };
    await expectRejected(client, id, async () => upload(client, await padded(limit + 1)), 413, 'image_too_large');
    assert.equal((await upload(client, await padded(limit))).status, 200);
  });

  test('sai cấu trúc tải lên: thiếu tệp, sai tên trường, hai tệp', async () => {
    const { client, id } = await student();
    const image = await photo();
    await expectRejected(client, id, () => client.put('/api/avatars/me', { form: new FormData() }), 400, 'image_empty');
    await expectRejected(client, id, () => upload(client, image, { field: 'avatar' }), 400, 'invalid_upload');
    const twoFiles = imageForm(image);
    twoFiles.append('image', new Blob([image], { type: 'image/jpeg' }), 'hai.jpg');
    await expectRejected(client, id, () => client.put('/api/avatars/me', { form: twoFiles }), 400, 'invalid_upload');
  });

  test('ảnh "bom giải nén" (tệp nhỏ, 144 triệu điểm ảnh) bị từ chối trước khi giải mã toàn bộ', async () => {
    const { client, id } = await student();
    const bomb = await canvas(12000, 12000, '#c8dcf0').png({ compressionLevel: 9 }).toBuffer();
    assert.ok(bomb.length < 1024 * 1024, 'tệp phải lọt qua giới hạn dung lượng');
    const original = console.error;
    console.error = () => {};
    try {
      await expectRejected(client, id, () => upload(client, bomb), 400, 'image_unreadable');
    } finally {
      console.error = original;
    }
  });

  test('ảnh mới bị từ chối thì ảnh đang dùng vẫn giữ nguyên', async () => {
    const { client } = await student();
    const { avatarUrl } = (await upload(client, await photo())).data.user;
    assert.equal((await upload(client, Buffer.from('khong phai anh'))).status, 415);
    assert.equal((await client.get('/api/auth/me')).data.user.avatarUrl, avatarUrl);
    assert.equal((await fetchImage(avatarUrl)).res.status, 200);
  });
});

describe('bảng xếp hạng', () => {
  test('mỗi dòng có URL ảnh hoặc null, không lộ id hay mã sinh viên', async () => {
    const [withPhoto, withoutPhoto] = [await student({ name: 'Có Ảnh' }), await student({ name: 'Không Ảnh' })];
    const { avatarUrl } = (await upload(withPhoto.client, await photo())).data.user;
    for (const { client } of [withPhoto, withoutPhoto]) {
      assert.equal((await client.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 200);
    }
    const { personal } = (await createClient(ctx.base).get('/api/stats/leaderboard')).data;
    assert.equal(personal.find((row) => row.name === 'Có Ảnh').avatarUrl, avatarUrl);
    assert.equal(personal.find((row) => row.name === 'Không Ảnh').avatarUrl, null);
    for (const row of personal) assert.deepEqual(Object.keys(row).sort(), ['avatarUrl', 'checkIns', 'name', 'points', 'rank']);
  });
});
