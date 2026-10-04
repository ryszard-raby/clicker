import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Runner } from '../src/runtime.js';
import { scan } from '../src/dom.js';
import { TEXT_MODEL, parseText, textRequest } from '../src/core.js';
import { gmTransport } from '../src/tampermonkey.js';

function setup() {
  const dom = new JSDOM('<form><input type="search" aria-label="Szukaj"><button type="button">Szukaj</button></form><p id="result"></p>', { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  return dom.window.document;
}
const decision = choice => ({ answers: { next: { type: 'choice', choice, confidence: 1 }, achieved: { type: 'noul', noul: 0 } } });
const completion = value => ({ choices: [{ message: { content: JSON.stringify({ value }) }, finish_reason: 'stop' }] });
const store = { async save() {}, async clear() {} };

test('console diagnostics identify HTTP requests and redact the API key', async () => {
  const document = setup();
  const records = [];
  const runner = new Runner({ document, openaiApiKey: 'openai-key', store, apiKey: 'secret-console-key', console: { info: (...args) => records.push(args) }, transport: async (body, context) => {
    context.onHttp({ status: 200, response: context.apiKey, requestId: 'trace-123' });
    return body.model === TEXT_MODEL ? completion('bluza') : decision(body.state.stage === 'component' ? 'g0' : 'a0');
  } });
  await runner.start({ goal: 'bluza', mode: 'yolo', maxSteps: 1, settleMs: 100 });
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('secret-console-key'));
  assert.match(serialized, /REDACTED/);
  const http = records.map(record => record[1]).find(record => record.event === 'http');
  assert.equal(http.status, 200);
  assert.equal(http.requestId, 'trace-123');
  assert.equal(http.id, 1);
  assert.ok(records.some(record => record[1].model === TEXT_MODEL && record[1].event === 'request'));
});

test('text generation sends only goal, bounded field label and length limit', () => {
  const body = textRequest('znajdź czarną bluzę', { url: 'PRIVATE_URL', title: 'PRIVATE_TITLE', groups: [{ text: 'PRIVATE_COMPONENT' }] }, { label: 'Szukaj', maxLength: 100, currentValue: 'PRIVATE_VALUE', placeholder: 'PRIVATE_PLACEHOLDER' });
  const text = body.messages[1].content;
  assert.ok(!text.includes('PRIVATE_'));
  assert.deepEqual(JSON.parse(text), { goal: 'znajdź czarną bluzę', field: 'Szukaj', maxLength: 100 });
});

test('JEV delegates fill to Luna, then chooses Search; logs and manual approvals include the value', async () => {
  const document = setup();
  const files = new Map();
  const requests = [];
  const approvals = [];
  const input = document.querySelector('input');
  let events = 0;
  input.addEventListener('input', () => events++);
  input.addEventListener('change', () => events++);
  document.querySelector('button').onclick = () => { assert.equal(input.value, 'bluza'); document.querySelector('#result').textContent = 'Wyniki'; };
  const runner = new Runner({ document, openaiApiKey: 'openai-key', store, apiKey: 'same-key', logger: { async reset() {}, async write(name, data) { files.set(name, structuredClone(data)); } }, confirm: async action => { approvals.push(action); return true; }, transport: async (body, context) => {
    assert.equal(context.apiKey, body.model === TEXT_MODEL ? 'openai-key' : 'same-key');
    requests.push(body);
    if (body.model === TEXT_MODEL) { assert.match(body.messages[1].content, /dodaj bluzę/); return completion('bluza'); }
    if (body.state.stage === 'component') return decision('g0');
    return decision(body.state.page.actions.find(action => action.kind === (input.value ? 'click' : 'fill')).id);
  } });
  await runner.start({ goal: 'dodaj bluzę do koszyka', mode: 'manual', settleMs: 100, success: { type: 'text', value: 'Wyniki' } });
  assert.equal(requests.length, 5);
  assert.equal(requests[2].model, TEXT_MODEL);
  assert.equal(files.get('request-3.json').model, TEXT_MODEL);
  assert.deepEqual(files.get('response-3.json'), completion('bluza'));
  assert.deepEqual(approvals.map(action => action.kind), ['fill', 'click']);
  assert.equal(approvals[0].value, 'bluza');
  assert.equal(events, 2);
  assert.equal(runner.state.steps, 2);
});

test('text parser rejects refusal, malformed, truncated and oversized output', () => {
  for (const data of [completion(null), completion(''), completion('abcd'), { choices: [{ message: { content: 'plain text' }, finish_reason: 'stop' }] }, { choices: [{ message: { content: '{"value":"ok"}' }, finish_reason: 'length' }] }]) {
    assert.throws(() => parseText(data, { maxLength: 3 }));
  }
});

test('missing OpenAI key stops before transport and never reuses the DefAPI key', async () => {
  const document = setup();
  let called = false;
  const runner = new Runner({ document, store, apiKey: 'defapi-only', debug: false, transport: async body => {
    if (body.model === TEXT_MODEL) { called = true; throw new Error('Should not send'); }
    return decision(body.state.stage === 'component' ? 'g0' : 'a0');
  } });
  await runner.start({ goal: 'Search', mode: 'yolo' });
  assert.equal(called, false);
  assert.equal(document.querySelector('input').value, '');
});

test('OpenAI refusal is rejected even when a value is present', () => {
  assert.throws(() => parseText({ choices: [{ finish_reason: 'stop', message: { refusal: 'Refused', content: '{"value":"text"}' } }] }, { maxLength: 100 }));
});

test('sensitive and readonly inputs are not offered for filling', () => {
  const document = setup();
  document.body.insertAdjacentHTML('beforeend', '<input type="password" value="secret"><input type="email"><input readonly value="private"><input type="file">');
  const snapshot = scan(document).publicState;
  assert.equal(snapshot.actions.filter(action => action.kind === 'fill').length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.ok(!JSON.stringify(snapshot).includes('private'));
});

test('Stop interrupts Luna and leaves the input untouched', async () => {
  const document = setup();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const runner = new Runner({ document, openaiApiKey: 'openai-key', store, transport: body => {
    if (body.model === TEXT_MODEL) { entered(); return new Promise(() => {}); }
    return Promise.resolve(decision(body.state.stage === 'component' ? 'g0' : 'a0'));
  } });
  const run = runner.start({ goal: 'bluza', mode: 'yolo' });
  await waiting;
  await runner.stop();
  await run;
  assert.equal(document.querySelector('input').value, '');
});

test('a rejected generated value never changes the input', async () => {
  const document = setup();
  const runner = new Runner({ document, openaiApiKey: 'openai-key', store, confirm: async () => false, transport: async body => body.model === TEXT_MODEL ? completion('bluza') : decision(body.state.stage === 'component' ? 'g0' : 'a0') });
  await runner.start({ goal: 'bluza', mode: 'manual' });
  assert.equal(document.querySelector('input').value, '');
});

test('GM transport routes Luna to OpenAI chat completions using the same authorization', async () => {
  const transport = gmTransport(options => {
    assert.equal(options.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer same-key');
    assert.deepEqual(JSON.parse(options.data), { model: TEXT_MODEL, messages: [] });
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(completion('bluza')) }));
    return { abort() {} };
  });
  await transport({ model: TEXT_MODEL, messages: [] }, { apiKey: 'same-key', signal: new AbortController().signal });
});

test('text generated for a changed field is discarded before execution', async () => {
  const document = setup();
  let calls = 0;
  const runner = new Runner({ document, openaiApiKey: 'openai-key', store, transport: async body => {
    if (body.model === TEXT_MODEL) {
      document.querySelector('input').placeholder = `changed-${++calls}`;
      return completion('bluza');
    }
    return decision(body.state.stage === 'component' ? 'g0' : 'a0');
  } });
  await runner.start({ goal: 'bluza', mode: 'yolo' });
  assert.equal(calls, 5);
  assert.equal(document.querySelector('input').value, '');
});
