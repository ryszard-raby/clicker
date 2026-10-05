import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scan } from '../src/dom.js';
import { requestBody, actionGroups } from '../src/core.js';
import { Runner } from '../src/runtime.js';

function doc(html) {
  const dom = new JSDOM(html, { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100 }];
  return dom.window.document;
}
const answer = (choice, confidence = 1) => ({ answers: { next: { type: 'choice', choice, confidence }, achieved: { type: 'noul', noul: 0 } } });
const store = () => ({ async save() {}, async clear() {} });

test('large action components are narrowed before sending actionable choices', async () => {
  const document = doc('<p>Offers</p>');
  const page = { url: document.URL, title: 'Offers', text: 'Offers', groups: [{ id: 'g0', text: 'Offers', heading: 'Offers', selected: [] }], actions: Array.from({ length: 128 }, (_, i) => ({ id: `a${i}`, group: 'g0', kind: 'click', label: `Offer ${i}`, context: `Shop ${Math.floor(i / 4)}` })) };
  const batches = actionGroups(page, 'g0');
  assert.ok(batches.length <= 16);
  assert.equal(new Set(batches.flatMap(group => group.actionIds)).size, 128);
  const stages = [];
  const runner = new Runner({ planning: false, debug: false, document, store: store(), transport: async body => {
    stages.push(body.state.stage);
    if (body.state.stage === 'action-group') {
      assert.ok(body.state.page.components.length <= 16);
      assert.equal(body.state.page.actions, undefined);
      assert.equal(body.questions.next.criteria.done, undefined);
      return answer(body.state.page.components.at(-1).id);
    }
    assert.ok(body.state.page.actions.length <= 24);
    return answer(body.state.page.actions.at(-1).id);
  } });
  runner.state = { config: { goal: 'Choose last offer', confidence: 0.2 }, history: [], startedAt: Date.now() };
  runner.running = true;
  runner.controller = new AbortController();
  const result = await runner.decide(page, 'g0');
  assert.equal(result.answers.next.choice, 'a127');
  assert.deepEqual(stages, ['action-group', 'action']);
});

test('crowded recommendations collapse into sections without losing scanned actions', () => {
  const cards = prefix => Array.from({ length: 20 }, (_, i) => `<div><article><a href="/${prefix}/${i}">${prefix} ${i}</a><button>Add</button></article></div>`).join('');
  const page = scan(doc(`<main><section><h2>Recommended</h2>${cards('Recommended')}</section><section><h2>Recent</h2>${cards('Recent')}</section></main>`)).publicState;
  assert.ok(page.groups.length <= 24);
  assert.equal(page.actions.length, 80);
  assert.equal(new Set(page.actions.slice(0, 40).map(action => action.group)).size, 1);
  assert.notEqual(page.actions[0].group, page.actions[40].group);
  const body = requestBody('Find a product', page, []);
  assert.ok(body.state.page.components.every(group => group.clickLabels.length <= 8));
});

test('adaptive grouping preserves separate quiz questions on crowded pages', () => {
  const page = scan(doc(`<main>${Array.from({ length: 30 }, (_, i) => `<fieldset><legend>Question ${i}</legend><label><input type="radio" name="q${i}">Yes</label><label><input type="radio" name="q${i}">No</label></fieldset>`).join('')}</main>`)).publicState;
  assert.equal(page.groups.length, 30);
  assert.equal(page.actions.length, 60);
});

test('header controls form one component while main stays separate', () => {
  const page = scan(doc('<div><header><a href="/">Logo</a><form><input placeholder="Search"><button>Search</button></form><nav><a href="/cart">Cart</a></nav></header><main><section><button>Product</button></section></main></div>')).publicState;
  assert.equal(page.groups.length, 2);
  assert.equal(new Set(page.actions.slice(0, 4).map(action => action.group)).size, 1);
  assert.notEqual(page.actions.at(-1).group, page.actions[0].group);
});

test('recommendation cards share their parent and retain product context', () => {
  const page = scan(doc('<main><section><h2>Recommended</h2><ul><li><a href="/red">Red hoodie</a><button>Add</button></li><li><a href="/black">Black hoodie</a><button>Add</button></li></ul></section><section><button>Other</button></section></main>')).publicState;
  assert.equal(new Set(page.actions.slice(0, 4).map(action => action.group)).size, 1);
  const buttons = page.actions.filter(action => action.label === 'Add');
  assert.match(buttons[0].context, /Red hoodie/);
  assert.match(buttons[1].context, /Black hoodie/);
  assert.notEqual(page.actions.at(-1).group, page.actions[0].group);
});

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
  const runner = new Runner({ planning: false, document, store: store(), transport: async body => {
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
  const runner = new Runner({ planning: false, document, store: store(), onStatus: message => statuses.push(message), transport: async body => {
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
  const runner = new Runner({ planning: false, document, store: store(), transport: async body => answer(body.state.stage === 'component' ? 'g0' : 'a1') });
  await runner.start({ goal: 'Test', mode: 'yolo' });
  assert.equal(clicks, 0);
});

test('uncertain component selection requires consent even for a confident checkbox action', async () => {
  const document = doc('<label><input type="checkbox">Red</label>');
  let approvals = 0;
  const runner = new Runner({ planning: false, document, store: store(), transport: async body => answer(body.state.stage === 'component' ? 'g0' : 'a0', body.state.stage === 'component' ? 0.4 : 1), confirm: async action => { approvals++; assert.equal(action.confidence, 0.4); return false; } });
  await runner.start({ goal: 'Test', mode: 'manual', confidence: 0.7 });
  assert.equal(approvals, 1);
  assert.equal(document.querySelector('input').checked, false);
});

test('a DOM change during component selection discards the plan before asking for an action', async () => {
  const document = doc('<button>Original</button>');
  let calls = 0;
  const runner = new Runner({ planning: false, document, store: store(), transport: async body => {
    assert.equal(body.state.stage, 'component');
    document.querySelector('button').textContent = `Changed ${++calls}`;
    return answer('g0');
  } });
  await runner.start({ goal: 'Test', settleMs: 100 });
  assert.equal(calls, 5);
});
