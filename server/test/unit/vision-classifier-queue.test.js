// Hàng đợi suy luận của bộ phân loại (createInferenceQueue) với việc giả: không cần mô hình hay DB nên luôn chạy.
// Kiểm tra: chạy lần lượt, giới hạn maxQueue khi gọi đồng thời, hết giờ không trả chỗ trước khi việc thật sự xong.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceQueue } from '../../src/services/visionClassifier.js';
import { VisionEngineError } from '../../src/services/visionShared.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const withStatus = (status) => (err) => err instanceof VisionEngineError && err.status === status;

/** Việc giả: ghi thứ tự bắt đầu, đếm số việc chạy cùng lúc; chỉ xong khi test gọi finish */
function fakeJobs() {
  const state = { running: 0, peak: 0, started: [] };
  const gates = new Map();
  const job = (name) => () => {
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    state.started.push(name);
    return new Promise((resolve, reject) => gates.set(name, { resolve, reject })).finally(() => {
      state.running -= 1;
    });
  };
  const finish = async (name, error) => {
    const gate = gates.get(name);
    assert.ok(gate, `việc ${name} chưa bắt đầu`);
    if (error) gate.reject(error);
    else gate.resolve(name);
    await tick();
  };
  return { state, job, finish };
}

describe('hàng đợi suy luận', () => {
  test('chạy lần lượt: việc sau chỉ bắt đầu khi việc trước xong', async () => {
    const queue = createInferenceQueue();
    const { state, job, finish } = fakeJobs();
    const results = ['a', 'b', 'c'].map((name) => queue.run(job(name), { maxQueue: 5, timeoutMs: 5000 }));
    await tick();
    assert.deepEqual(state.started, ['a']);
    await finish('a');
    assert.deepEqual(state.started, ['a', 'b']);
    await finish('b');
    await finish('c');
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
    assert.equal(state.peak, 1);
    assert.equal(queue.pending, 0);
  });

  test('nhiều lượt gọi trong cùng một tick: nhận đúng maxQueue, còn lại báo bận ngay', async () => {
    const queue = createInferenceQueue();
    const { job, finish } = fakeJobs();
    // Gắn xử lý ngay trong tick tạo ra để lượt bị từ chối không thành "unhandled rejection"
    const settled = Promise.allSettled(Array.from({ length: 10 }, (_, i) => queue.run(job(`v${i}`), { maxQueue: 3, timeoutMs: 5000 })));
    assert.equal(queue.pending, 3);
    for (const name of ['v0', 'v1', 'v2']) {
      await tick();
      await finish(name);
    }
    const outcomes = await settled;
    assert.deepEqual(
      outcomes.map((o) => o.status),
      [...Array(3).fill('fulfilled'), ...Array(7).fill('rejected')]
    );
    assert.ok(outcomes.slice(3).every((o) => withStatus('busy')(o.reason)));
    assert.equal(queue.pending, 0);
  });

  test('hết giờ khi đang chạy: người gọi nhận timeout ngay, nhưng chỗ và lượt chạy chỉ được trả khi việc thật sự xong', async () => {
    const queue = createInferenceQueue();
    const { state, job, finish } = fakeJobs();
    const slow = queue.run(job('cham'), { maxQueue: 2, timeoutMs: 30 });
    const next = queue.run(job('sau'), { maxQueue: 2, timeoutMs: 5000 });
    await assert.rejects(slow, withStatus('timeout'));

    // Việc chậm vẫn đang chạy (không dừng được): việc sau chưa được chạy chồng lên, chỗ của việc chậm vẫn bị giữ
    assert.deepEqual(state.started, ['cham']);
    assert.equal(queue.pending, 2);
    await assert.rejects(queue.run(job('thua'), { maxQueue: 2, timeoutMs: 5000 }), withStatus('busy'));

    await finish('cham');
    assert.deepEqual(state.started, ['cham', 'sau']);
    await finish('sau');
    assert.equal(await next, 'sau');
    assert.equal(state.peak, 1);
    assert.equal(queue.pending, 0);
  });

  test('việc treo hẳn chỉ giữ hàng tối đa 3 × timeoutMs rồi bị bỏ, có log; việc sau vẫn chạy được', async (t) => {
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
    const queue = createInferenceQueue();
    const started = [];
    const stuck = queue.run(() => {
      started.push('treo');
      return new Promise(() => {});
    }, { maxQueue: 2, timeoutMs: 20 });
    const next = queue.run(async () => {
      started.push('sau');
      return 'sau';
    }, { maxQueue: 2, timeoutMs: 5000 });
    await assert.rejects(stuck, withStatus('timeout'));
    assert.deepEqual(started, ['treo'], 'vừa hết giờ: việc treo vẫn giữ lượt chạy');
    assert.equal(await next, 'sau');
    assert.deepEqual(started, ['treo', 'sau']);
    assert.equal(queue.pending, 0);
    assert.ok(logged.some((l) => l.includes('[vision] Bộ phân loại chưa xong sau 60 ms')), logged.join('\n'));
  });

  test('thời gian chờ trong hàng không tính vào timeoutMs', async () => {
    const queue = createInferenceQueue();
    const { job, finish } = fakeJobs();
    const first = queue.run(job('dau'), { maxQueue: 2, timeoutMs: 5000 });
    let settled = false;
    const waiting = queue.run(job('cho'), { maxQueue: 2, timeoutMs: 30 }).finally(() => {
      settled = true;
    });
    await sleep(100);
    assert.equal(settled, false, 'đang chờ quá 30 ms nhưng chưa tới lượt nên chưa hết giờ');
    await finish('dau');
    await finish('cho');
    assert.deepEqual(await Promise.all([first, waiting]), ['dau', 'cho']);
  });

  test('việc lỗi (kể cả ném đồng bộ): người gọi nhận đúng lỗi, hàng vẫn chạy tiếp, chỗ được trả', async () => {
    const queue = createInferenceQueue();
    const { job, finish } = fakeJobs();
    const broken = new VisionEngineError('invalid_image', 'ảnh hỏng');
    // assert.rejects gắn xử lý ngay; chỉ await sau khi các việc đã chạy
    const failing = assert.rejects(queue.run(job('loi'), { maxQueue: 3, timeoutMs: 5000 }), (err) => err === broken);
    const throwing = assert.rejects(
      queue.run(() => {
        throw new Error('ném đồng bộ');
      }, { maxQueue: 3, timeoutMs: 5000 }),
      /ném đồng bộ/
    );
    const after = queue.run(job('sau'), { maxQueue: 3, timeoutMs: 5000 });
    await tick();
    await finish('loi', broken);
    await failing;
    await throwing;
    await finish('sau');
    assert.equal(await after, 'sau');
    assert.equal(queue.pending, 0);
  });

  test('xong bình thường thì trả chỗ trước khi báo người gọi: lượt nhìn thứ hai gọi ngay với maxQueue = 1 không bị báo bận', async () => {
    const queue = createInferenceQueue();
    const options = { maxQueue: 1, timeoutMs: 5000 };
    const firstLook = await queue.run(async () => 'lan-dau', options);
    const secondLook = await queue.run(async () => 'lan-hai', options);
    assert.deepEqual([firstLook, secondLook], ['lan-dau', 'lan-hai']);
  });
});
