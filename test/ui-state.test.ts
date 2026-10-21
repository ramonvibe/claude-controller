import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromSnapshot, applyEvent, cardStatus } from '../web/src/status.ts';

const ev = (kind: string, agentId: string, taskId: string) => ({ kind, agentId, taskId });

test('card: green from started to result, gray otherwise', () => {
  let s = fromSnapshot({ running: [], last: [] });
  assert.equal(cardStatus(s, 'a'), 'idle');
  s = applyEvent(s, ev('started', 'a', 't1'));
  assert.equal(cardStatus(s, 'a'), 'running');
  s = applyEvent(s, ev('delta', 'a', 't1'));
  assert.equal(cardStatus(s, 'a'), 'running');
  s = applyEvent(s, ev('result', 'a', 't1'));
  assert.equal(cardStatus(s, 'a'), 'idle');
});

test('card: several agents green at once', () => {
  let s = fromSnapshot({ running: [], last: [] });
  s = applyEvent(s, ev('started', 'a', 't1'));
  s = applyEvent(s, ev('started', 'b', 't2'));
  assert.deepEqual([cardStatus(s, 'a'), cardStatus(s, 'b'), cardStatus(s, 'c')], ['running', 'running', 'idle']);
});

test('card: error stays red until the next task of that agent', () => {
  let s = fromSnapshot({ running: [], last: [] });
  s = applyEvent(s, ev('started', 'a', 't1'));
  s = applyEvent(s, ev('error', 'a', 't1'));
  assert.equal(cardStatus(s, 'a'), 'error');
  s = applyEvent(s, ev('started', 'b', 't2'));
  s = applyEvent(s, ev('result', 'b', 't2'));
  assert.equal(cardStatus(s, 'a'), 'error');
  s = applyEvent(s, ev('started', 'a', 't3'));
  assert.equal(cardStatus(s, 'a'), 'running');
  s = applyEvent(s, ev('result', 'a', 't3'));
  assert.equal(cardStatus(s, 'a'), 'idle');
});

test('card: reload rebuilds from running tasks and last status', () => {
  const s = fromSnapshot({
    running: [{ id: 't1', agentId: 'a' }],
    last: [{ agentId: 'a', status: 'running' }, { agentId: 'b', status: 'error' }, { agentId: 'c', status: 'done' }],
  });
  assert.deepEqual(['a', 'b', 'c'].map((x) => cardStatus(s, x)), ['running', 'error', 'idle']);
  assert.equal(cardStatus(applyEvent(s, ev('result', 'a', 't1')), 'a'), 'idle');
});
