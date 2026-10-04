import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scan, execute } from '../src/dom.js';
import { requestBody, parseDecision } from '../src/core.js';
import { Runner as ActualRunner } from '../src/runtime.js';
import { mount } from '../src/panel.js';
import { gmTransport, gmTabStore } from '../src/tampermonkey.js';
import { readFile } from 'node:fs/promises';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://example.org/quiz', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') || this.style.display === 'none' ? [] : [{ width: 100, height: 25 }];
  };
  return dom;
}
function memory() {
  let data;
  return { load: async () => data, save: async value => { data = structuredClone(value); }, clear: async () => { data = null; } };
}
function answer(choice, noul = 0.01, confidence = 0.99) {
  return { answers: { next: { type: 'choice', choice, confidence }, achieved: { type: 'noul', noul } } };
}
const config = { goal: 'Wypełnij quiz', settleMs: 100, mode: 'manual', confidence: 0.7 };

// Existing action-level scenarios automatically select their first component.
class Runner extends ActualRunner {
  constructor(options) {
    super({ ...options, transport: async (body, context) => {
      if (body.state.stage === 'component' && body.state.page.components.some(group => group.actionCount)) {
        return answer(body.state.page.components.find(group => group.actionCount).id);
      }
      return options.transport(body, context);
    } });
  }
}

test('ten quiz cards keep independent question context, labels, and selected state', () => {
  const doc = page(Array.from({ length: 10 }, (_, i) => `<fieldset><legend>Pytanie ${i}: ile to ${i}+1?</legend><label><input type="radio" name="q${i}"> ${i + 1}</label><label><input type="radio" name="q${i}"> ${i + 2}</label></fieldset>`).join('')).window.document;
  const snapshot = scan(doc);
  assert.equal(snapshot.publicState.groups.length, 10);
  assert.equal(snapshot.publicState.actions.length, 20);
  assert.match(snapshot.publicState.groups[8].text, /Pytanie 8/);
  assert.equal(snapshot.publicState.actions[16].label, '9');
  execute(snapshot.refs.get('a16'));
  assert.equal(doc.querySelector('[name="q8"]').checked, true);
  assert.equal(scan(doc).publicState.actions.length, 19);
  assert.deepEqual(scan(doc).publicState.groups[8].selected, [{ kind: 'radio', label: '9' }]);
});

test('common ancestor fallback groups answers with adjacent question', () => {
  const doc = page('<div><h3>Stolica Polski?</h3><div><label><input type="radio" name="a">Warszawa</label><label><input type="radio" name="a">Kraków</label></div></div>').window.document;
  assert.match(scan(doc).publicState.groups[0].text, /Stolica Polski/);
});

test('excludes hidden controls, passwords, file inputs, disabled actions and own UI', () => {
  const doc = page('<input type="password" value="secret"><textarea>secret</textarea><input type="file"><button disabled>disabled</button><fieldset disabled><button>disabled group</button></fieldset><div hidden><button>hidden</button></div><div data-clickator-root><button>panel</button></div><button>ok</button>').window.document;
  const snapshot = scan(doc).publicState;
  assert.deepEqual(snapshot.actions.map(x => x.label), ['ok']);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('select generates typed choices and dispatches change', () => {
  const doc = page('<label>Kolor<select><option>Czerwony</option><option>Zielony</option><option disabled>Niebieski</option></select></label>').window.document;
  let changed = false;
  doc.querySelector('select').addEventListener('change', () => { changed = true; });
  const snapshot = scan(doc);
  assert.equal(snapshot.publicState.actions.length, 1);
  execute(snapshot.refs.get('a0'));
  assert.equal(doc.querySelector('select').value, 'Zielony');
  assert.ok(changed);
});

test('API request follows documented choice/noul schema; rejects unknown IDs and missing confidence', () => {
  const snapshot = scan(page('<button>Go</button>').window.document).publicState;
  const body = requestBody('go', snapshot, []);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.equal(body.questions.next.type, 'choice');
  assert.equal(body.questions.achieved.type, 'noul');
  assert.throws(() => parseDecision(answer('alien'), snapshot.actions));
  const bad = answer('a0'); delete bad.answers.next.confidence;
  assert.throws(() => parseDecision(bad, snapshot.actions));
});

test('manual mode checks answers but requires consent before submit; deterministic success', async () => {
  const doc = page('<label><input type="checkbox">Tak</label><button>Wyślij</button><p id="result"></p>').window.document;
  let approvals = 0;
  doc.querySelector('button').onclick = () => { doc.querySelector('#result').textContent = 'Ukończono'; };
  const status = [];
  const runner = new ActualRunner({ document: doc, store: memory(), confirm: async () => { approvals++; return true; }, transport: async body => answer(body.state.stage === 'component' ? (doc.querySelector('input').checked ? 'g1' : 'g0') : (doc.querySelector('input').checked ? 'a1' : 'a0')), onStatus: s => status.push(s) });
  await runner.start({ ...config, success: { type: 'text', value: 'Ukończono' } });
  assert.equal(approvals, 1);
  assert.equal(runner.state.steps, 2);
  assert.match(status.at(-1), /Cel osiągnięty/);
});

test('denied manual action never clicks', async () => {
  const doc = page('<button>Pay</button>').window.document;
  let clicks = 0;
  doc.querySelector('button').onclick = () => clicks++;
  const runner = new Runner({ document: doc, store: memory(), confirm: async () => false, transport: async () => answer('a0') });
  await runner.start(config);
  assert.equal(clicks, 0);
});

test('YOLO skips consent and stops when actions make no progress', async () => {
  const doc = page('<button>No-op</button>').window.document;
  let clicks = 0;
  doc.querySelector('button').onclick = () => clicks++;
  const status = [];
  const runner = new Runner({ document: doc, store: memory(), confirm: async () => { throw new Error('Should not ask'); }, transport: async () => answer('a0'), onStatus: s => status.push(s) });
  await runner.start({ ...config, mode: 'yolo' });
  assert.equal(clicks, 2);
  assert.match(status.at(-1), /Brak widocznego postępu/);
});

test('model completion requires two high probability observations; custom rule overrides it', async () => {
  const doc = page('<p>Wynik</p>').window.document;
  let calls = 0;
  const statuses = [];
  const runner = new Runner({ document: doc, store: memory(), transport: async () => { calls++; return answer('done', 0.99); }, onStatus: s => statuses.push(s) });
  await runner.start(config);
  assert.equal(calls, 2);
  assert.match(statuses.at(-1), /dwukrotnie/);
  await runner.start({ ...config, success: { type: 'text', value: 'Nie istnieje' } });
  assert.match(statuses.at(-1), /nie został spełniony/);
});

test('Stop cancels an in-flight transport even when transport ignores abort', async () => {
  const doc = page('<button>Go</button>').window.document;
  const runner = new Runner({ document: doc, store: memory(), transport: () => new Promise(() => {}) });
  const run = runner.start(config);
  await new Promise(resolve => setTimeout(resolve, 10));
  await runner.stop();
  await run;
  assert.equal(runner.running, false);
  assert.equal(runner.state.steps, 0);
});

test('stale DOM response is discarded before clicking', async () => {
  const doc = page('<button>First</button>').window.document;
  let clicks = 0;
  let calls = 0;
  doc.querySelector('button').onclick = () => clicks++;
  const runner = new Runner({ document: doc, store: memory(), transport: async () => { calls++; doc.querySelector('button').textContent = `Changed ${calls}`; return answer('a0'); } });
  await runner.start({ ...config, mode: 'yolo' });
  assert.equal(calls, 5);
  assert.equal(clicks, 0);
});

test('checkpoint restores step budget across page loads', async () => {
  const doc = page('<button>Go</button>').window.document;
  const store = memory();
  await store.save({ config: { ...config, maxSteps: 2 }, active: true, steps: 2, startedAt: Date.now(), history: [], seen: [] });
  let called = false;
  const runner = new Runner({ document: doc, store, transport: async () => { called = true; return answer('a0'); } });
  await runner.resume();
  assert.equal(called, false);
  assert.equal(await store.load(), null);
});

test('built artifact exposes API and mounts panel without a module loader', async () => {
  const dom = page('<p>Demo</p>');
  dom.window.eval(await readFile(new URL('../dist/clickator.js', import.meta.url), 'utf8'));
  assert.equal(typeof dom.window.Clickator.create, 'function');
  dom.window.Clickator.mount({ store: memory() });
  assert.ok(dom.window.document.querySelector('[data-clickator-root]'));
});

test('low confidence stops before any click', async () => {
  const doc = page('<button>Go</button>').window.document;
  let clicks = 0;
  doc.querySelector('button').onclick = () => clicks++;
  const runner = new Runner({ document: doc, store: memory(), transport: async () => answer('a0', 0, 0.2) });
  await runner.start({ ...config, mode: 'yolo' });
  assert.equal(clicks, 0);
});

test('Stop also cancels an unanswered consent request', async () => {
  const doc = page('<button>Go</button>').window.document;
  let asked;
  const waiting = new Promise(resolve => { asked = resolve; });
  const runner = new Runner({ document: doc, store: memory(), transport: async () => answer('a0'), confirm: () => { asked(); return new Promise(() => {}); } });
  const run = runner.start(config);
  await waiting;
  await runner.stop();
  await run;
  assert.equal(runner.state.steps, 0);
});

test('GM adapter sends documented authenticated request and propagates HTTP failures', async () => {
  const transport = gmTransport(options => {
    assert.equal(options.url, 'https://api.defapi.org/api/v1/decisions');
    assert.equal(options.headers.Authorization, 'Bearer test');
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(answer('done', 1)) }));
    return { abort() {} };
  });
  const context = { apiKey: 'test', signal: new AbortController().signal };
  assert.equal((await transport({}, context)).answers.next.choice, 'done');
  const failure = gmTransport(options => { queueMicrotask(() => options.onload({ status: 401 })); return { abort() {} }; });
  await assert.rejects(failure({}, context), /401/);
});

test('GM tab store serializes a checkpoint followed by Stop and preserves unrelated data', async () => {
  let tab = { unrelated: true };
  const store = gmTabStore(cb => queueMicrotask(() => cb(structuredClone(tab))), (value, cb) => { tab = structuredClone(value); queueMicrotask(cb); });
  const saved = store.save({ active: true, steps: 5 });
  const cleared = store.clear();
  await Promise.all([saved, cleared]);
  assert.equal(await store.load(), null);
  assert.deepEqual(tab, { unrelated: true });
});

test('hidden selector is not accepted as success', async () => {
  const doc = page('<p id="success" style="visibility:hidden">Done</p>').window.document;
  let calls = 0;
  const runner = new Runner({ document: doc, store: memory(), transport: async () => { calls++; return answer('blocked'); } });
  await runner.start({ ...config, success: { type: 'selector', value: '#success' } });
  assert.equal(calls, 1);
});

test('manual asks before uncertain checkbox actions and obeys approval or rejection', async () => {
  for (const allowed of [true, false]) {
    const doc = page('<fieldset><legend>Włączyć filtr?</legend><label><input type="checkbox">Tak</label></fieldset>').window.document;
    let approvals = 0;
    const runner = new Runner({ document: doc, store: memory(), transport: async () => answer('a0', 0, 0.6), confirm: async action => {
      approvals++;
      assert.equal(doc.querySelector('input').checked, false);
      assert.equal(action.confidence, 0.6);
      assert.equal(action.threshold, 0.7);
      assert.match(action.context, /Włączyć filtr/);
      return allowed;
    } });
    await runner.start({ ...config, maxSteps: 1 });
    assert.equal(approvals, 1);
    assert.equal(doc.querySelector('input').checked, allowed);
  }
});

test('YOLO accepts confidence equal to the configured threshold', async () => {
  const doc = page('<label><input type="checkbox">Tak</label>').window.document;
  const runner = new Runner({ document: doc, store: memory(), transport: async () => answer('a0', 0, 0.6), confirm: async () => { throw new Error('Unexpected approval'); } });
  await runner.start({ ...config, mode: 'yolo', confidence: 0.6, maxSteps: 1 });
  assert.equal(doc.querySelector('input').checked, true);
});

test('uncertain done does not bypass success verification through manual approval', async () => {
  const doc = page('<p>Quiz</p>').window.document;
  let approvals = 0;
  const statuses = [];
  const runner = new Runner({ document: doc, store: memory(), transport: async () => answer('done', 1, 0.6), confirm: async () => { approvals++; return true; }, onStatus: message => statuses.push(message) });
  await runner.start(config);
  assert.equal(approvals, 0);
  assert.match(statuses.at(-1), /poniżej progu 70%/);
  assert.equal(runner.state.successVotes, 0);
});

test('panel passes the selected confidence percentage into the runner', async () => {
  const dom = page('<p>Quiz</p>');
  let shadow;
  const attach = dom.window.HTMLElement.prototype.attachShadow;
  dom.window.HTMLElement.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  const runner = mount({ document: dom.window.document, store: memory() });
  let received;
  runner.start = async options => { received = options; };
  shadow.getElementById('goal').value = 'Test';
  shadow.getElementById('confidence').value = '60';
  shadow.getElementById('start').click();
  assert.equal(received.confidence, 0.6);
  dom.window.close();
});


test('mount automatically resumes a navigated session, including one with a lost log folder', async () => {
  for (const logging of [false, true]) {
    const dom = page('<button>Add to cart</button><p id="result"></p>');
    const doc = dom.window.document;
    const store = memory();
    const startedAt = Date.now();
    const history = [{ step: 1, url: 'https://example.org/category', action: { kind: 'click', label: 'Samsung S26' } }];
    await store.save({ config: { goal: 'Add Samsung S26 to cart', mode: 'yolo', settleMs: 100, success: { type: 'text', value: 'In cart' } }, active: true, logging, requestId: 2, steps: 1, startedAt, history, seen: [] });
    let clicks = 0;
    doc.querySelector('button').onclick = () => { clicks++; doc.querySelector('#result').textContent = 'In cart'; };
    let finished;
    const completion = new Promise(resolve => { finished = resolve; });
    const runner = mount({ document: doc, store, transport: async body => {
      assert.equal(body.state.goal, 'Add Samsung S26 to cart');
      assert.equal(body.state.history[0].action.label, 'Samsung S26');
      return answer(body.state.stage === 'component' ? 'g0' : 'a0');
    }, onStatus: (message, state) => { if (state && !state.active) finished(); } });
    await completion;
    assert.equal(clicks, 1);
    assert.equal(runner.state.steps, 2);
    assert.equal(runner.state.requestId, 4);
    assert.equal(runner.state.startedAt, startedAt);
    assert.equal(runner.state.logging, false);
    assert.equal(await store.load(), null);
    dom.window.close();
  }
});

test('automatic resume can be disabled and never resumes a stopped session', async () => {
  for (const active of [false, true]) {
    const dom = page('<button>Add to cart</button>');
    const store = memory();
    await store.save({ active, config: { goal: 'Test' } });
    let calls = 0;
    const runner = mount({ document: dom.window.document, store, ...(active ? { autoResume: false } : {}), transport: async () => { calls++; return answer('blocked'); } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    assert.equal(runner.running, false);
    dom.window.close();
  }
});
