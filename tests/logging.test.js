import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Runner } from '../src/runtime.js';
import { directoryLogger } from '../src/logging.js';

function setup(transport) {
  const dom = new JSDOM('<p>Test</p>', { url: 'https://example.org' });
  const files = new Map();
  const directory = {
    async *entries() { for (const name of files.keys()) yield [name, { kind: 'file' }]; },
    async getFileHandle(name) { return { async createWritable() {
      let content;
      return { async write(text) { content = text; }, async close() { files.set(name, JSON.parse(content)); }, async abort() {} };
    } }; },
  };
  let checkpoint;
  const store = { async load() { return checkpoint; }, async save(state) { checkpoint = structuredClone(state); }, async clear() { checkpoint = null; } };
  const logger = directoryLogger(directory);
  const runner = new Runner({ planning: false, document: dom.window.document, store, logger, apiKey: 'secret-test-key', transport });
  return { files, logger, runner, store };
}
const done = { answers: { next: { type: 'choice', choice: 'done', confidence: 1 }, achieved: { type: 'noul', noul: 1 } } };

test('paired JSON logs capture each call, reset on Start, and preserve unrelated files', async () => {
  const { runner, files } = setup(async body => {
    const id = runner.state.requestId;
    assert.deepEqual(files.get(`request-${id}.json`), body);
    assert.deepEqual(files.get(`response-${id}.json`), { status: 'pending' });
    return done;
  });
  await runner.start({ goal: 'First', settleMs: 100 });
  assert.deepEqual(files.get('response-2.json'), done);
  files.set('notes.json', { keep: true });
  runner.transport = async () => ({ answers: { ...done.answers, next: { type: 'choice', choice: 'blocked', confidence: 1 } } });
  await runner.start({ goal: 'Second', settleMs: 100 });
  assert.equal(files.get('request-1.json').state.goal, 'Second');
  assert.equal(files.get('response-1.json').answers.next.choice, 'blocked');
  assert.equal(files.get('request-2.json').status, 'not_requested_in_current_session');
  assert.deepEqual(files.get('notes.json'), { keep: true });
  assert.ok(!JSON.stringify([...files]).includes('secret-test-key'));
});

test('errors including HTTP response bodies are written into the matching response file', async () => {
  const { runner, files } = setup(async () => { throw Object.assign(new Error('JEV HTTP 429'), { response: '{"message":"rate limit"}' }); });
  await runner.start({ goal: 'Test' });
  assert.equal(files.get('response-1.json').status, 'error');
  assert.equal(files.get('response-1.json').response, '{"message":"rate limit"}');
});

test('resume keeps request numbering without resetting earlier logs', async () => {
  const { runner, files, store } = setup(async () => ({ answers: { ...done.answers, next: { type: 'choice', choice: 'blocked', confidence: 1 } } }));
  files.set('request-1.json', { original: true });
  await store.save({ config: { goal: 'Resume' }, active: true, logging: true, requestId: 3, steps: 0, startedAt: Date.now(), history: [], seen: [] });
  await runner.resume();
  assert.deepEqual(files.get('request-1.json'), { original: true });
  assert.ok(files.has('request-4.json'));
  assert.ok(files.has('response-4.json'));
});

test('logging failure stops before sending an unlogged request', async () => {
  let calls = 0;
  const { runner } = setup(async () => { calls++; return done; });
  runner.logger.write = async () => { throw new Error('Disk full'); };
  await runner.start({ goal: 'Test' });
  assert.equal(calls, 0);
  assert.equal(runner.running, false);
});

test('resume of a logged session requires a logger', async () => {
  const { runner, store } = setup(async () => done);
  await store.save({ config: { goal: 'Resume' }, active: true, logging: true });
  runner.logger = null;
  await assert.rejects(runner.resume(), /folder logów/);
});
