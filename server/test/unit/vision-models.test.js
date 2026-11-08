// Tệp mô hình nhận diện: chỉ vào máy qua lệnh tải có ghim revision, kiểm tra kích thước + mã băm (A08 — toàn vẹn)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLASSIFIER_MODEL, MODEL_MANIFEST, downloadModel, gitBlobSha1, modelDir, modelFilePath, verifyModelFiles } from '../../src/services/visionModels.js';

const FILES = {
  'config.json': Buffer.from('{"model_type":"test"}'),
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
  test('bộ phân loại mặc định ghim commit và mã băm của tệp ONNX 8 MB; manifest chỉ còn bộ phân loại ONNX, không còn CLIP/SigLIP', () => {
    assert.equal(DEFAULT_CLASSIFIER_MODEL, 'onnxmodelzoo/mobilenetv3_small_075_Opset17');
    const classifier = MODEL_MANIFEST[DEFAULT_CLASSIFIER_MODEL];
    assert.equal(classifier.revision, '1c237e98b27e20fa2be3e5bcaee3b4c28208e6a9');
    assert.deepEqual(classifier.files['mobilenetv3_small_075_Opset17.onnx'], {
      size: 8179614,
      sha256: 'ef7b5191b3e2586c409ddcfbfef42a6434a9ac885608b8d16e9c767c518f1c31',
    });
    assert.match(classifier.license, /Apache-2\.0/);
    assert.deepEqual(Object.keys(MODEL_MANIFEST).filter((id) => /clip|siglip/i.test(id)), []);
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      if (entry.source === 'local') {
        // Mô hình huấn luyện tại chỗ: không có commit trên Hugging Face, ghim bằng sha256 của từng tệp
        for (const meta of Object.values(entry.files)) assert.match(meta.sha256, /^[0-9a-f]{64}$/, id);
      } else {
        assert.match(entry.revision, /^[0-9a-f]{40}$/, 'ghim theo commit, không theo nhánh');
        for (const meta of Object.values(entry.files)) assert.ok(meta.sha256 || meta.gitSha1);
      }
    }
  });

  test('mô hình huấn luyện tại chỗ trên ảnh thật (DINOv2 của weights.pt + đầu tuyến tính 9 lớp): ghim sha256, đủ 9 lớp đầu ra', () => {
    const entry = MODEL_MANIFEST['greencanteen/bev9-dinov2-vitb-280-int8'];
    assert.equal(entry.source, 'local');
    assert.deepEqual(entry.files['model.int8.onnx'], {
      size: 87429450,
      sha256: '3d271658d446eb97d858f1e4c2569b7b42a2136eb08282215bf910c412df9856',
    });
    assert.match(entry.license, /CC BY 4\.0/);
    assert.equal(entry.calibratedThreshold, 0.95);
    assert.deepEqual(entry.input.shape, [1, 3, 280, 280]);
    // Mỗi chỉ số đầu ra thuộc đúng một loại nghiệp vụ; 9 lớp đều được ánh xạ (không có residual → ảnh lạ vẫn bị gán một lớp)
    const mapped = Object.values(entry.classMapping).filter(Array.isArray).flat().sort((a, b) => a - b);
    assert.deepEqual(mapped, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(entry.classes.length, 9);
    assert.deepEqual(entry.classMapping.reusable_bottle.map((i) => entry.classes[i]), ['gym bottle']);
    assert.deepEqual(entry.classMapping.reusable_cup.map((i) => entry.classes[i]), ['cup-handle', 'glass-mug', 'glass-normal']);
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
    fs.writeFileSync(modelFilePath('test/mo-hinh', 'config.json', dir), Buffer.from('{"model_type":"TEST"}'));
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

describe('mô hình huấn luyện tại chỗ (source: local)', () => {
  test('không bao giờ gọi mạng; thiếu tệp → báo cách chép tệp vào đúng chỗ; đủ tệp đúng mã băm → xong', async () => {
    fs.rmSync(path.join(dir, 'local'), { recursive: true, force: true });
    const content = Buffer.from('trong-so-huan-luyen-tai-cho');
    const local = { 'local/mo-hinh': { source: 'local', revision: null, files: { 'model.onnx': { size: content.length, sha256: sha256(content) } } } };
    const hub = fakeHub();
    await assert.rejects(
      downloadModel('local/mo-hinh', { dir, manifest: local, fetchImpl: hub.fetchImpl, log: () => {} }),
      /huấn luyện tại chỗ[\s\S]*vision:verify/
    );
    assert.deepEqual(hub.urls, [], 'không gọi Hugging Face cho mô hình không có trên đó');

    fs.mkdirSync(path.dirname(modelFilePath('local/mo-hinh', 'model.onnx', dir)), { recursive: true });
    fs.writeFileSync(modelFilePath('local/mo-hinh', 'model.onnx', dir), content);
    await downloadModel('local/mo-hinh', { dir, manifest: local, fetchImpl: hub.fetchImpl, log: () => {} });
    assert.deepEqual(hub.urls, []);
    assert.deepEqual(await verifyModelFiles('local/mo-hinh', dir, local), []);
  });

  // Đưa tệp lên máy chủ không có trong git (vd. volume trên Railway): người vận hành tự đặt tệp ở một địa chỉ HTTPS, server tải về và
  // chỉ nhận khi đúng kích thước + sha256 ghim trong manifest, nên địa chỉ bị tráo nội dung cũng không lọt được mô hình khác
  test('có url (VISION_MODEL_URL): tải đúng địa chỉ đó, sai mã băm thì dừng và không để lại tệp, đúng thì ghi', async () => {
    fs.rmSync(path.join(dir, 'local'), { recursive: true, force: true });
    const content = Buffer.from('trong-so-huan-luyen-tai-cho');
    const local = { 'local/mo-hinh': { source: 'local', revision: null, files: { 'model.onnx': { size: content.length, sha256: sha256(content) } } } };
    const urls = [];
    const serve = (body) => async (url) => {
      urls.push(String(url));
      return new Response(body, { status: 200 });
    };
    const url = 'https://kho.example.org/tam/model.onnx';
    await assert.rejects(
      downloadModel('local/mo-hinh', { dir, manifest: local, url, fetchImpl: serve(Buffer.from('noi-dung-bi-trao-27b')), log: () => {} }),
      /kích thước hoặc mã băm không khớp/
    );
    assert.deepEqual(fs.readdirSync(path.dirname(modelFilePath('local/mo-hinh', 'model.onnx', dir))), [], 'không còn tệp tạm hay tệp hỏng');
    await downloadModel('local/mo-hinh', { dir, manifest: local, url, fetchImpl: serve(content), log: () => {} });
    assert.deepEqual(urls, [url, url]);
    assert.deepEqual(await verifyModelFiles('local/mo-hinh', dir, local), []);
  });

  test('url phải là https và chỉ dùng cho mô hình huấn luyện tại chỗ; mô hình trên Hugging Face luôn tải theo commit đã ghim', async () => {
    const content = Buffer.from('x');
    const local = { 'local/khac': { source: 'local', revision: null, files: { 'model.onnx': { size: 1, sha256: sha256(content) } } } };
    const never = async () => assert.fail('không được gọi mạng');
    await assert.rejects(downloadModel('local/khac', { dir, manifest: local, url: 'http://kho.example.org/m.onnx', fetchImpl: never, log: () => {} }), /https/);
    await assert.rejects(downloadModel('test/mo-hinh', { dir, manifest: MANIFEST, url: 'https://kho.example.org/m.onnx', fetchImpl: never, log: () => {} }), /chỉ dùng cho mô hình huấn luyện tại chỗ/);
  });
});

describe('giá trị mặc định (dùng bởi lệnh npm run vision:*)', () => {
  test('đường dẫn tệp mặc định nằm trong thư mục mô hình của server', () => {
    assert.equal(
      modelFilePath(DEFAULT_CLASSIFIER_MODEL, 'mobilenetv3_small_075_Opset17.onnx'),
      path.join(modelDir(), 'onnxmodelzoo', 'mobilenetv3_small_075_Opset17', 'mobilenetv3_small_075_Opset17.onnx')
    );
  });

  test('mô hình ngoài manifest bị từ chối trước khi gọi mạng', async () => {
    await assert.rejects(downloadModel('nguoi-la/x'), /không có trong danh sách đã ghim/);
  });
});
