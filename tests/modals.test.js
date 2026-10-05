import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scan, execute } from '../src/dom.js';
import { requestBody } from '../src/core.js';
import { Runner } from '../src/runtime.js';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ left: 10, top: 10, right: 110, bottom: 50 }];
  };
  return dom.window.document;
}
const store = { async save() {}, async clear() {} };
const answer = choice => ({ answers: { next: { type: 'choice', choice, confidence: 1 }, achieved: { type: 'noul', noul: 0 } } });

test('dialog at end of a large page takes precedence over background controls', () => {
  const doc = page('<button>Background</button>'.repeat(170) + '<div role="dialog" aria-label="Cookies"><h2>Privacy</h2><button>Reject</button></div>');
  const state = scan(doc).publicState;
  assert.deepEqual(state.actions.map(a => a.label), ['Reject']);
  assert.equal(state.truncated, false);
  assert.equal(state.activeDialog.label, 'Cookies');
  assert.ok(!state.text.includes('Background'));
  assert.equal(requestBody('Continue', state, []).state.page.activeDialog.label, 'Cookies');
});

test('nested dialog wins; closing it restores the parent then the page', () => {
  const doc = page('<button>Background</button><dialog open><button>Parent</button><div role="alertdialog"><button>Confirm</button></div></dialog>');
  assert.deepEqual(scan(doc).publicState.actions.map(a => a.label), ['Confirm']);
  doc.querySelector('[role=alertdialog]').hidden = true;
  assert.deepEqual(scan(doc).publicState.actions.map(a => a.label), ['Parent']);
  doc.querySelector('dialog').hidden = true;
  assert.deepEqual(scan(doc).publicState.actions.map(a => a.label), ['Background']);
});

test('dialog retains its portalled listbox options', () => {
  const doc = page('<button>Background</button><div role="dialog"><button role="combobox" aria-controls="options">Size</button></div><div role="listbox" id="options"><div role="option">XL</div></div>');
  assert.deepEqual(scan(doc).publicState.actions.map(a => a.label), ['Size', 'XL']);
});

test('hit testing excludes covered controls and rechecks before execution', () => {
  const doc = page('<button id="target">Buy</button><div id="overlay">Overlay</div>');
  const target = doc.querySelector('#target'), overlay = doc.querySelector('#overlay');
  doc.elementsFromPoint = () => [target];
  const ref = scan(doc).refs.get('a0');
  let clicked = false;
  target.onclick = () => { clicked = true; };
  doc.elementsFromPoint = () => [overlay, target];
  assert.equal(scan(doc).publicState.actions.length, 0);
  assert.throws(() => execute(ref), /zasłonięty/);
  assert.equal(clicked, false);
});

test('a new dialog blocks an old background reference even without hit testing', () => {
  const doc = page('<button>Buy</button>');
  const ref = scan(doc).refs.get('a0');
  doc.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button>Cancel</button></div>');
  assert.throws(() => execute(ref), /zasłonięty/);
});

test('popup appearing during model request invalidates decision and is handled first', async () => {
  const doc = page('<button id="buy">Buy</button>');
  let bought = false, closed = false, calls = 0;
  doc.querySelector('#buy').onclick = () => { bought = true; };
  const runner = new Runner({ document: doc, store, debug: false, transport: async body => {
    if (++calls === 1) {
      doc.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button id="close">Close popup</button></div>');
      doc.querySelector('#close').onclick = () => { closed = true; doc.querySelector('[role=dialog]').remove(); doc.body.insertAdjacentHTML('beforeend', '<p>Popup handled</p>'); };
      return answer('g0');
    }
    assert.ok(body.state.page.activeDialog);
    return answer(body.state.stage === 'component' ? 'g0' : body.state.page.actions[0].id);
  } });
  await runner.start({ goal: 'Close popup', settleMs: 100, success: { type: 'text', value: 'Popup handled' } });
  assert.equal(closed, true);
  assert.equal(bought, false);
  assert.equal(runner.state.steps, 1);
});

test('DOM settling waits for a delayed popup and stops promptly on abort', async () => {
  const doc = page('<button>Open</button>');
  const runner = new Runner({ document: doc, store, debug: false });
  runner.controller = new AbortController();
  let settled = false;
  const waiting = runner.delay(100).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 130));
  doc.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button>Close</button></div>');
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(settled, false);
  await waiting;
  assert.equal(scan(doc).publicState.activeDialog.role, 'dialog');
  const aborted = runner.delay(10000);
  runner.controller.abort();
  await aborted;
});
