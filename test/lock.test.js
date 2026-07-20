import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMutex } from '../lock.js';

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('createMutex', () => {
  test('runs queued fns one at a time, in call order, even if earlier ones are slower', async () => {
    const run = createMutex();
    const order = [];

    const p1 = run(async () => {
      order.push('start-1');
      await delay(20);
      order.push('end-1');
      return 1;
    });
    const p2 = run(async () => {
      order.push('start-2');
      await delay(5);
      order.push('end-2');
      return 2;
    });
    const p3 = run(() => {
      order.push('start-3');
      order.push('end-3');
      return 3;
    });

    const results = await Promise.all([p1, p2, p3]);

    assert.deepEqual(results, [1, 2, 3]);
    // Task 2 must not start until task 1 has fully finished, even though
    // task 2's own work is faster -- proves serialization, not just
    // eventual ordering of results.
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  test('propagates each fn resolution/rejection to its own caller', async () => {
    const run = createMutex();

    const ok = run(() => 'value');
    const err = run(() => {
      throw new Error('boom');
    });

    assert.equal(await ok, 'value');
    await assert.rejects(() => err, /boom/);
  });

  test('a rejecting task does not wedge the queue for subsequent tasks', async () => {
    const run = createMutex();
    const order = [];

    const p1 = run(async () => {
      order.push('run-1');
      throw new Error('task 1 failed');
    });
    const p2 = run(async () => {
      order.push('run-2');
      return 'still runs';
    });
    const p3 = run(async () => {
      order.push('run-3');
      return 'also still runs';
    });

    await assert.rejects(() => p1, /task 1 failed/);
    assert.equal(await p2, 'still runs');
    assert.equal(await p3, 'also still runs');
    assert.deepEqual(order, ['run-1', 'run-2', 'run-3']);
  });

  test('supports sync (non-async) fns transparently', async () => {
    const run = createMutex();
    const result = await run(() => 42);
    assert.equal(result, 42);
  });

  test('two independent mutexes do not serialize against each other', async () => {
    const runA = createMutex();
    const runB = createMutex();
    const order = [];

    const pA = runA(async () => {
      order.push('A-start');
      await delay(20);
      order.push('A-end');
    });
    const pB = runB(async () => {
      order.push('B-start');
      await delay(5);
      order.push('B-end');
    });

    await Promise.all([pA, pB]);

    // B, running on its own mutex, finishes before A even though A started
    // first -- proves the two queues are independent.
    assert.deepEqual(order, ['A-start', 'B-start', 'B-end', 'A-end']);
  });
});
