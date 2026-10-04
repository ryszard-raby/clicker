import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scan, execute } from '../src/dom.js';
import { Runner } from '../src/runtime.js';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  return dom.window.document;
}
const answer = choice => ({ answers: { next: { type: 'choice', choice, confidence: 1 }, achieved: { type: 'noul', noul: 0 } } });

test('station fields inside combobox wrappers remain fillable and labels identify direction', () => {
  const document = page('<form><label for="from">Jadę z</label><div role="combobox"><input id="from" aria-autocomplete="list"></div><label for="to">Jadę do</label><div role="combobox"><input id="to" role="combobox" aria-autocomplete="list"></div></form>');
  const snapshot = scan(document);
  const fills = snapshot.publicState.actions.filter(action => action.kind === 'fill');
  assert.deepEqual(fills.map(action => action.label), ['Jadę z', 'Jadę do']);
  assert.ok(snapshot.publicState.actions.filter(action => action.kind === 'dropdown').every(action => action.label !== 'DIV'));
  const ref = snapshot.refs.get(fills[0].id);
  ref.action.value = 'Kraków Główny';
  execute(ref);
  assert.equal(document.activeElement, document.querySelector('#from'));
  assert.equal(document.querySelector('#from').value, 'Kraków Główny');
});

test('opens custom dropdown then selects a portalled option with owner context', async () => {
  const document = page('<div role="combobox" aria-label="Rozmiar" aria-controls="sizes" aria-expanded="false">Wybierz</div><div id="sizes" role="listbox" hidden><div role="option">S</div><div role="option">M</div><div role="option" aria-disabled="true">L</div></div><p id="result"></p>');
  const trigger = document.querySelector('[role=combobox]');
  const popup = document.querySelector('[role=listbox]');
  trigger.onclick = () => { trigger.setAttribute('aria-expanded', 'true'); popup.hidden = false; };
  document.querySelectorAll('[role=option]')[1].onclick = event => { event.target.setAttribute('aria-selected', 'true'); popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.textContent = 'M'; document.querySelector('#result').textContent = 'Wybrano M'; };
  const runner = new Runner({ document, debug: false, store: { async save() {}, async clear() {} }, transport: async body => {
    if (body.state.stage === 'component') {
      const group = body.state.page.components.find(group => group.kinds.includes(popup.hidden ? 'dropdown' : 'option'));
      return answer(group.id);
    }
    const actions = body.state.page.actions;
    if (popup.hidden) return answer(actions.find(action => action.kind === 'dropdown').id);
    assert.equal(body.state.page.component.heading, 'Rozmiar');
    assert.ok(!actions.some(action => action.label === 'L'));
    return answer(actions.find(action => action.label === 'M').id);
  } });
  await runner.start({ goal: 'Wybierz rozmiar M', settleMs: 100, success: { type: 'text', value: 'Wybrano M' } });
  assert.equal(trigger.textContent, 'M');
  assert.equal(runner.state.steps, 2);
});

test('readonly combobox is clickable and nested options are not discarded', () => {
  const document = page('<input readonly role="combobox" aria-label="Kolor"><div role="combobox" aria-label="Rozmiar" aria-expanded="true"><div role="listbox"><div role="option">XL</div></div></div>');
  const actions = scan(document).publicState.actions;
  assert.ok(actions.some(action => action.kind === 'dropdown' && action.label === 'Kolor'));
  assert.ok(actions.some(action => action.kind === 'option' && action.label === 'XL'));
  assert.ok(!actions.some(action => action.kind === 'fill'));
});

test('native multiselect can deselect and emits input/change', () => {
  const document = page('<select multiple><option selected>A</option><optgroup disabled><option>B</option></optgroup></select>');
  const select = document.querySelector('select');
  const events = [];
  select.oninput = () => events.push('input'); select.onchange = () => events.push('change');
  const snapshot = scan(document);
  assert.equal(snapshot.publicState.actions.length, 1);
  assert.equal(snapshot.publicState.actions[0].desiredSelected, false);
  execute(snapshot.refs.get('a0'));
  assert.equal(select.options[0].selected, false);
  assert.deepEqual(events, ['input', 'change']);
});
