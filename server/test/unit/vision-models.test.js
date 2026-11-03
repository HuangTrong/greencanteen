// Tệp mô hình nhận diện: chỉ vào máy qua lệnh tải có ghim revision, kiểm tra kích thước + mã băm (A08 — toàn vẹn)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_MANIFEST, downloadModel, gitBlobSha1, modelDir, modelFilePath, verifyModelFiles } from '../../src/services/visionModels.js';

const FILES = {
  'config.json': Buffer.from('{"model_type":"clip"}'),
  'onnx/model_quantized.onnx': Buffer.from('trong-so-gia-lap-cho-test'),
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MANIFEST = {
  'test/mo-hinh': {
    revision: 'abc123',
    files: {
      'config.json': { size: FILES['config.json'].length, gitSha1: gitBlobSha1(FILES['config.json']) },
      'onnx/model_quantized.onnx': { size: FILES['onnx/model_quantized.onnx'].length, sha256: sha256(FILES['onnx/model_quantized.onnx']) },
    },
  },
};

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-models-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const fakeHub = (overrides = {}) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const file = String(url).split('/resolve/abc123/')[1];
    const content = overrides[file] ?? FILES[file];
    return content ? new Response(content, { status: 200 }) : new Response('not found', { status: 404 });
  };
  return { urls, fetchImpl };
};

describe('manifest mô hình đã ghim', () => {
  test('CLIP mặc định ghim commit và mã băm của tệp ONNX 145 MB; SigLIP (Apache-2.0) là lựa chọn thay thế', () => {
    const clip = MODEL_MANIFEST['Xenova/clip-vit-base-patch16'];
    assert.equal(clip.revision, '342fdf2f67aded64d138ff074745fb4a5d2bba5f');
    assert.deepEqual(clip.files['onnx/model_quantized.onnx'], {
      size: 152040303,
      sha256: 'cf5b03d7c03cd78498b0d59a905552b549ae91af4e99ffb985103aa9424d2272',
    });
    assert.match(MODEL_MANIFEST['Xenova/siglip-base-patch16-224'].license, /Apache-2\.0/);
    for (const entry of Object.values(MODEL_MANIFEST)) {
      assert.match(entry.revision, /^[0-9a-f]{40}$/, 'ghim theo commit, không theo nhánh');
      for (const meta of Object.values(entry.files)) assert.ok(meta.sha256 || meta.gitSha1);
    }
  });

  test('SHA-1 kiểu git blob đúng chuẩn (git hash-object)', () => {
    assert.equal(gitBlobSha1(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('verifyModelFiles', () => {
  test('thiếu tệp / sai kích thước / sai mã băm / mô hình lạ', async () => {
    assert.deepEqual(await verifyModelFiles('nguoi-la/x', dir, MANIFEST), [{ file: null, problem: 'unknown_model' }]);
    const problems = await verifyModelFiles('test/mo-hinh', dir, MANIFEST);
    assert.deepEqual(problems.map((p) => p.problem), ['missing', 'missing']);

    fs.mkdirSync(path.dirname(modelFilePath('test/mo-hinh', 'onnx/model_quantized.onnx', dir)), { recursive: true });
    fs.writeFileSync(modelFilePath('test/mo-hinh', 'config.json', dir), Buffer.from('{"model_type":"CLIP"}'));
    fs.writeFileSync(modelFilePath('test/mo-hinh', 'onnx/model_quantized.onnx', dir), Buffer.from('ngan'));
    assert.deepEqual((await verifyModelFiles('test/mo-hinh', dir, MANIFEST)).map((p) => p.problem), ['hash_mismatch', 'size_mismatch']);
  });
});

describe('downloadModel — tải theo revision đã ghim, kiểm tra trước khi ghi', () => {
  test('tải đúng URL /resolve/<commit>/, ghi tệp, lần sau bỏ qua tệp đã đúng', async () => {
    fs.rmSync(path.join(dir, 'test'), { recursive: true, force: true });
    const hub = fakeHub();
    const lines = [];
    await downloadModel('test/mo-hinh', { dir, manifest: MANIFEST, fetchImpl: hub.fetchImpl, log: (l) => lines.push(l) });
    assert.deepEqual(hub.urls, [
      'https://huggingface.co/test/mo-hinh/resolve/abc123/config.json',
      'https://huggingface.co/test/mo-hinh/resolve/abc123/onnx/model_quantized.onnx',
    ]);
    assert.deepEqual(await verifyModelFiles('test/mo-hinh', dir, MANIFEST), []);

    const again = fakeHub();
    await downloadModel('test/mo-hinh', { dir, manifest: MANIFEST, fetchImpl: again.fetchImpl, log: (l) => lines.push(l) });
    assert.deepEqual(again.urls, [], 'không tải lại tệp đã khớp mã băm');
    assert.ok(lines.some((l) => l.includes('đã có')));
  });

  test('nội dung bị sửa trên đường truyền → dừng, không để lại tệp; lỗi HTTP → dừng', async () => {
    fs.rmSync(path.join(dir, 'test'), { recursive: true, force: true });
    const tampered = fakeHub({ 'onnx/model_quantized.onnx': Buffer.from('trong-so-DA-BI-SUA-cho-test') });
    await assert.rejects(
      downloadModel('test/mo-hinh', { dir, manifest: MANIFEST, fetchImpl: tampered.fetchImpl, log: () => {} }),
      /onnx\/model_quantized\.onnx: kích thước hoặc mã băm không khớp/
    );
    const onnxDir = path.dirname(modelFilePath('test/mo-hinh', 'onnx/model_quantized.onnx', dir));
    assert.deepEqual(fs.readdirSync(onnxDir), [], 'không còn tệp tạm hay tệp hỏng');

    const missing = { 'test/mo-hinh': { ...MANIFEST['test/mo-hinh'], files: { 'khong-co.json': { size: 1, gitSha1: 'x' } } } };
    await assert.rejects(downloadModel('test/mo-hinh', { dir, manifest: missing, fetchImpl: fakeHub().fetchImpl, log: () => {} }), /HTTP 404/);
    await assert.rejects(downloadModel('nguoi-la/x', { dir, manifest: MANIFEST, log: () => {} }), /không có trong danh sách/);
  });
});

describe('giá trị mặc định (dùng bởi lệnh npm run vision:*)', () => {
  test('đường dẫn tệp mặc định nằm trong thư mục mô hình của server', () => {
    assert.equal(modelFilePath('Xenova/clip-vit-base-patch16', 'onnx/model_quantized.onnx'), path.join(modelDir(), 'Xenova', 'clip-vit-base-patch16', 'onnx', 'model_quantized.onnx'));
  });

  test('mô hình ngoài manifest bị từ chối trước khi gọi mạng', async () => {
    await assert.rejects(downloadModel('nguoi-la/x'), /không có trong danh sách đã ghim/);
  });
});
