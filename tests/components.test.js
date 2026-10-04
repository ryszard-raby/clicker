import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scan } from '../src/dom.js';
import { requestBody } from '../src/core.js';
import { Runner } from '../src/runtime.js';

function doc(html) {
  const dom = new JSDOM(html, { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100 }];
  return dom.window.document;
}
const answer = (choice, confidence = 1) => ({ answers: { next: { type: 'choice', choice, confidence }, achieved: { type: 'noul', noul: 0 } } });
const store = () => ({ async save() {}, async clear() {} });

test('product title and visible main heading reach both stages outside the action component', () => {
  const document = doc('<title>Sklep — Bluza</title><h1 hidden>Nieaktualny produkt</h1><h1>Bluza bawełniana</h1><section><button>Dodaj do koszyka</button></section>');
  const snapshot = scan(document).publicState;
  for (const component of [null, snapshot.actions[0].group]) {
    const body = requestBody('Dodaj bluzę do koszyka', snapshot, [], component);
    assert.equal(body.state.page.title, 'Sklep — Bluza');
    assert.deepEqual(body.state.page.headings, ['Bluza bawełniana']);
  }
});

test('component selection contains no action list; action selection exposes only chosen component', () => {
  const document = doc('<fieldset><legend>Color</legend><label><input type="checkbox">Red</label></fieldset><fieldset><legend>Size</legend><button>Large</button></fieldset>');
  const page = scan(document).publicState;
  const first = requestBody('Filter', page, []);
  assert.equal(first.state.stage, 'component');
  assert.equal(first.state.page.actions, undefined);
  assert.deepEqual(Object.keys(first.questions.next.criteria), ['g0', 'g1', 'done', 'blocked']);
  const second = requestBody('Filter', page, [], 'g0');
  assert.equal(second.state.stage, 'action');
  assert.deepEqual(second.state.page.actions.map(action => action.id), ['a0']);
  assert.equal(second.state.page.components, undefined);
  assert.ok(!JSON.stringify(second).includes('Large'));
  assert.equal(second.questions.next.criteria.done, undefined);
});

test('filter then Apply reselects components using current selection and history', async () => {
  const document = doc('<form><fieldset><legend>Color</legend><label><input type="checkbox">Red</label></fieldset><button type="button">Filter</button></form><p id="result"></p>');
  document.querySelector('button').onclick = () => { document.querySelector('#result').textContent = 'Filtered'; };
  const requests = [];
  const runner = new Runner({ document, store: store(), transport: async body => {
    requests.push(body);
    const selected = document.querySelector('input').checked;
    if (body.state.stage === 'component') {
      if (selected) {
        assert.equal(body.state.history.at(-1).action.desiredChecked, true);
        assert.equal(body.state.page.components[0].selected[0].label, 'Red');
      }
      return answer(selected ? 'g1' : 'g0');
    }
    assert.equal(body.state.page.actions.length, 1);
    return answer(body.state.page.actions[0].id);
  } });
  await runner.start({ goal: 'Choose Red and apply filters', mode: 'yolo', settleMs: 100, success: { type: 'text', value: 'Filtered' } });
  assert.deepEqual(requests.map(body => body.state.stage), ['component', 'action', 'component', 'action']);
  assert.equal(document.querySelector('#result').textContent, 'Filtered');
  assert.equal(runner.state.steps, 2);
  assert.equal(runner.state.requestId, 4);
});

test('submit input remains discoverable in a long component description', () => {
  const document = doc(`<form><h2>Options</h2><p>${'Description '.repeat(50)}</p><input type="submit" value="Filtruj"></form>`);
  const page = scan(document).publicState;
  const body = requestBody('Apply filters', page, []);
  assert.deepEqual(body.state.page.components[0].clickLabels, ['Filtruj']);
  assert.match(body.questions.next.criteria.g0, /Filtruj/);
  assert.equal(page.actions[0].label, 'Filtruj');
});

test('submit input receives current filter selections and submits with the original submitter', async () => {
  const document = doc('<form><fieldset><legend>Offers</legend><label><input type="checkbox">Buy now</label></fieldset><input type="submit" value="Filtruj"></form><p id="result"></p>');
  const submit = document.querySelector('[type="submit"]');
  let submissions = 0;
  const statuses = [];
  document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    assert.equal(event.submitter, submit);
    assert.equal(document.querySelector('[type="checkbox"]').checked, true);
    submissions++;
    document.querySelector('#result').textContent = 'Applied';
  });
  const runner = new Runner({ document, store: store(), onStatus: message => statuses.push(message), transport: async body => {
    const checked = document.querySelector('[type="checkbox"]').checked;
    if (body.state.stage === 'component') return answer(checked ? 'g1' : 'g0');
    if (checked) {
      assert.deepEqual(body.state.page.selectedComponents, [{ id: 'g0', heading: 'Offers', selected: [{ kind: 'checkbox', label: 'Buy now' }] }]);
      assert.equal(body.state.page.actions[0].label, 'Filtruj');
      assert.match(body.questions.next.instructions, /selectedComponents/);
    }
    return answer(body.state.page.actions[0].id);
  } });
  await runner.start({ goal: 'Buy now and apply filters', mode: 'yolo', settleMs: 100, success: { type: 'text', value: 'Applied' } });
  assert.equal(submissions, 1);
  assert.equal(runner.state.steps, 2);
  const waiting = statuses.findIndex(message => /Czekam na odpowiedź JEV.*wybór akcji.*żądanie 4/.test(message));
  const saving = statuses.indexOf('Zapisuję sesję przed wykonaniem: Filtruj');
  const dispatched = statuses.indexOf('Wysłano akcję: Filtruj · czekam na zmianę strony');
  assert.ok(waiting >= 0 && saving > waiting && dispatched > saving);
});

test('action from a different component is rejected', async () => {
  const document = doc('<fieldset><button>One</button></fieldset><fieldset><button>Two</button></fieldset>');
  let clicks = 0;
  document.querySelectorAll('button').forEach(button => { button.onclick = () => clicks++; });
  const runner = new Runner({ document, store: store(), transport: async body => answer(body.state.stage === 'component' ? 'g0' : 'a1') });
  await runner.start({ goal: 'Test', mode: 'yolo' });
  assert.equal(clicks, 0);
});

test('uncertain component selection requires consent even for a confident checkbox action', async () => {
  const document = doc('<label><input type="checkbox">Red</label>');
  let approvals = 0;
  const runner = new Runner({ document, store: store(), transport: async body => answer(body.state.stage === 'component' ? 'g0' : 'a0', body.state.stage === 'component' ? 0.4 : 1), confirm: async action => { approvals++; assert.equal(action.confidence, 0.4); return false; } });
  await runner.start({ goal: 'Test' });
  assert.equal(approvals, 1);
  assert.equal(document.querySelector('input').checked, false);
});

test('a DOM change during component selection discards the plan before asking for an action', async () => {
  const document = doc('<button>Original</button>');
  let calls = 0;
  const runner = new Runner({ document, store: store(), transport: async body => {
    assert.equal(body.state.stage, 'component');
    document.querySelector('button').textContent = `Changed ${++calls}`;
    return answer('g0');
  } });
  await runner.start({ goal: 'Test', settleMs: 100 });
  assert.equal(calls, 5);
});
