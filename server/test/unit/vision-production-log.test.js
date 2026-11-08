// Log khởi động khi production dùng mô hình chưa hiệu chỉnh trên ảnh có nhãn: thường do quên VISION_CLASSIFIER_MODEL khi triển khai
// (README mục 8.11, Cách 3). Không cần tệp mô hình: chỉ đọc cấu hình và manifest.
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { logVisionStatus } from '../../src/services/vision.js';
import { setEnv } from '../helpers.js';

const CALIBRATED = 'greencanteen/bev9-dinov2-vitb-280-int8';

/** Các dòng logVisionStatus in ra, dạng "log: ...", "warn: ...", "error: ..." */
function statusLines() {
  const lines = [];
  const originals = ['log', 'warn', 'error'].map((method) => [method, console[method]]);
  for (const [method] of originals) console[method] = (...args) => lines.push(`${method}: ${args.join(' ')}`);
  try {
    logVisionStatus();
  } finally {
    for (const [method, fn] of originals) console[method] = fn;
  }
  return lines;
}
const uncalibratedError = (lines) => lines.find((l) => l.startsWith('error:') && l.includes('chưa được hiệu chỉnh trên ảnh có nhãn'));

beforeEach(() => setEnv());
after(() => setEnv());

describe('logVisionStatus — production với mô hình chưa hiệu chỉnh', () => {
  test('quên VISION_CLASSIFIER_MODEL (mặc định mobilenet): báo lỗi, chỉ ra mô hình đã hiệu chỉnh, nhưng không chặn', () => {
    setEnv({ NODE_ENV: 'production' });
    const lines = statusLines();
    const error = uncalibratedError(lines);
    assert.ok(error, lines.join('\n'));
    assert.match(error, /VISION_CLASSIFIER_MODEL=onnxmodelzoo\/mobilenetv3_small_075_Opset17 /);
    assert.ok(error.includes(`Mô hình đã hiệu chỉnh: ${CALIBRATED}`), error);
    assert.ok(lines.some((l) => l.startsWith('log: Nhận diện ảnh tại máy chủ')), lines.join('\n'));
  });

  test('mô hình chưa hiệu chỉnh khác trong manifest cũng bị báo', () => {
    setEnv({ NODE_ENV: 'production', VISION_CLASSIFIER_MODEL: 'onnxmodelzoo/efficientnet_lite0_Opset17' });
    assert.ok(uncalibratedError(statusLines()));
  });

  test('cấu hình giống máy hiệu chỉnh (README Cách 3): không có lỗi hay cảnh báo nào', () => {
    setEnv({
      NODE_ENV: 'production',
      VISION_ENGINE: 'classifier',
      VISION_CLASSIFIER_MODEL: CALIBRATED,
      VISION_CONFIDENCE_THRESHOLD: '0.95',
      VISION_TIMEOUT_MS: '60000',
    });
    const lines = statusLines();
    assert.deepEqual(lines.filter((l) => !l.startsWith('log:')), [], lines.join('\n'));
    assert.ok(lines.some((l) => l.includes(`(${CALIBRATED}, 2 luồng CPU), ngưỡng 0.95`)), lines.join('\n'));
  });

  test('khi phát triển không báo: mobilenet vẫn là mặc định để thử', () => {
    assert.equal(uncalibratedError(statusLines()), undefined);
  });
});
