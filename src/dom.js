const SELECTOR = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="link"], [role="option"], [role="tab"], [role="switch"], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const DROPDOWN = '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]';
const OPTION = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const SEMANTIC = 'fieldset, [role="radiogroup"], [role="group"], [role="listbox"], form, article, li, section';
const DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
export const clean = (text, max = 1600) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function visible(el) {
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return !!el.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden], [inert], [aria-hidden="true"], [data-clickator-root]');
}

// Ignore our own floating controls when checking what the page puts on top.
export function unobscured(el) {
  const doc = el.ownerDocument;
  if (!doc.elementsFromPoint) return true;
  const win = doc.defaultView;
  const rects = [...el.getClientRects()];
  let inViewport = false;
  for (const rect of rects) {
    const left = Math.max(0, rect.left), right = Math.min(win.innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(win.innerHeight, rect.bottom);
    if (!(right > left && bottom > top)) continue;
    inViewport = true;
    for (const [x, y] of [[.5, .5], [.2, .2], [.8, .8]]) {
      const hit = doc.elementsFromPoint(left + (right - left) * x, top + (bottom - top) * y)
        .find(node => !node.closest('[data-clickator-root]'));
      if (hit && (hit === el || el.contains(hit) || (el.labels && [...el.labels].some(label => label === hit || label.contains(hit))))) return true;
    }
  }
  // Offscreen controls remain available; modal scoping still applies to them.
  return !inViewport;
}

export function activeDialog(doc) {
  const candidates = [...doc.querySelectorAll(DIALOG)].filter(el => visible(el) && unobscured(el));
  const nativeModal = el => { try { return el.matches(':modal'); } catch { return false; } };
  return candidates.sort((a, b) => {
    if (a.contains(b)) return -1;
    if (b.contains(a)) return 1;
    return Number(nativeModal(a)) - Number(nativeModal(b)) ||
      (parseInt(doc.defaultView.getComputedStyle(a).zIndex, 10) || 0) - (parseInt(doc.defaultView.getComputedStyle(b).zIndex, 10) || 0);
  }).at(-1) || null;
}

function inDialogScope(el, dialog) {
  if (!dialog || dialog.contains(el)) return true;
  // Menus/listboxes can be rendered outside the dialog that owns them.
  return [...dialog.querySelectorAll('[aria-controls], [aria-owns]')].some(owner =>
    [...(owner.getAttribute('aria-controls') || '').split(/\s+/), ...(owner.getAttribute('aria-owns') || '').split(/\s+/)]
      .some(id => id && el.ownerDocument.getElementById(id)?.contains(el)));
}

export function textOf(el, max = 1600) {
  if (!el) return '';
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, 4);
  const parts = [];
  let length = 0;
  while (walker.nextNode() && length < max) {
    const parent = walker.currentNode.parentElement;
    if (parent && !parent.closest('script, style, noscript, textarea, [data-clickator-root]') && visible(parent)) {
      const text = clean(walker.currentNode.textContent, max);
      if (text) { parts.push(text); length += text.length + 1; }
    }
  }
  return clean(parts.join(' '), max);
}

export function labelOf(el) {
  const doc = el.ownerDocument;
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => textOf(doc.getElementById(id))).join(' ');
  const nestedInput = el.matches(DROPDOWN) ? el.querySelector('input:not([type="hidden"]):not([type="password"]), select') : null;
  return clean(labelled || el.getAttribute('aria-label') || [...(el.labels || [])].map(x => textOf(x)).join(' ') || (nestedInput ? labelOf(nestedInput) : '') || textOf(el) || el.getAttribute('title') || el.getAttribute('placeholder') || (['submit', 'button', 'reset'].includes(el.type) ? el.value : '') || el.name || el.tagName, 240);
}

// First meaningful common ancestor, with semantic boundaries preferred.
function localGroupFor(el, controls) {
  const semantic = el.closest(SEMANTIC);
  if (semantic && controls.filter(x => semantic.contains(x)).length <= 30) return semantic;
  let parent = el.parentElement;
  let fallback = parent || el;
  for (let depth = 0; parent && parent.tagName !== 'BODY' && depth < 7; depth++, parent = parent.parentElement) {
    const count = controls.filter(x => parent.contains(x)).length;
    if (count > 30) break;
    fallback = parent;
    if (count >= 2) {
      // An answer list often has a question immediately above it.
      const outer = parent.parentElement;
      if (outer && outer.tagName !== 'BODY' && controls.filter(x => outer.contains(x)).length === count) return outer;
      return parent;
    }
  }
  return fallback;
}

export function groupFor(el, controls) {
  const local = localGroupFor(el, controls);
  const protectedGroup = el.closest('fieldset, [role="radiogroup"], [role="listbox"], [role="menu"]');
  if (protectedGroup) return protectedGroup;
  const count = root => controls.filter(control => root.contains(control)).length;
  const header = el.closest('header, [role="banner"]');
  if (header && count(header) <= 80) return header;
  // Preserve individual questions and forms; expand display/navigation blocks.
  if (local.matches('form, [role="group"], ' + DIALOG)) return local;
  const outer = local.parentElement;
  if (!outer || outer.matches('body, html, main, [role="main"], form, ' + DIALOG)) return local;
  // Do not absorb unrelated page regions or multiple independent forms/questions.
  if (outer.querySelector('main, header, footer, [role="main"], [role="banner"], fieldset, [role="radiogroup"]') || outer.querySelectorAll('form').length > 1) return local;
  return count(outer) <= 80 ? outer : local;
}

// Coarsen crowded pages without crossing question, popup or page-region boundaries.
export function adaptiveGroups(controls) {
  const assigned = new Map(controls.map(el => [el, groupFor(el, controls)]));
  const protectedRoot = 'fieldset, [role="radiogroup"], [role="listbox"], [role="menu"], form, [role="group"]';
  for (let level = 0; level < 10 && new Set(assigned.values()).size > 12; level++) {
    const roots = [...new Set(assigned.values())];
    const candidates = [...new Set(roots.map(root => root.parentElement))].filter(parent => {
      if (!parent || parent.matches('html, body, main, [role="main"], ' + protectedRoot + ', ' + DIALOG)) return false;
      if (parent.querySelector(protectedRoot + ', main, header, footer, [role="main"], [role="banner"], ' + DIALOG)) return false;
      return controls.filter(el => parent.contains(el)).length <= 160;
    });
    let changed = false;
    for (const parent of candidates) {
      const children = [...new Set(assigned.values())].filter(root => parent.contains(root));
      if (children.some(root => root.matches(protectedRoot + ', ' + DIALOG))) continue;
      for (const [el, root] of assigned) if (children.includes(root) && root !== parent) {
        assigned.set(el, parent);
        changed = true;
      }
      if (new Set(assigned.values()).size <= 12) break;
    }
    if (!changed) break;
  }
  return assigned;
}

export function scan(doc) {
  const dialog = activeDialog(doc);
  const all = [...doc.querySelectorAll(SELECTOR)].filter(el => inDialogScope(el, dialog) && visible(el) && unobscured(el) && !el.matches(':disabled') && !el.closest('[aria-disabled="true"]'));
  // Avoid duplicate nested button/role targets.
  const controls = all.filter(el => el.matches(OPTION) || !all.some(other => other !== el && other.contains(el) && !(other.matches(DROPDOWN) && el.matches('input, select'))));
  const groupedControls = adaptiveGroups(controls);
  const groups = [];
  const roots = new Map();
  const refs = new Map();
  const actions = [];
  let truncated = controls.length > 320;
  for (const el of controls.slice(0, 320)) {
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['text', 'search', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) || (el.readOnly && !el.matches(DROPDOWN))) continue;
    const popup = el.matches(OPTION) ? el.closest('[role="listbox"], [role="menu"]') : null;
    const owner = popup ? controls.find(control => control.matches(DROPDOWN) && (control.contains(popup) || [...(control.getAttribute('aria-controls') || '').split(/\s+/), ...(control.getAttribute('aria-owns') || '').split(/\s+/)].some(id => id && doc.getElementById(id)?.contains(popup)))) : null;
    const grouped = groupedControls.get(el);
    const root = popup || (dialog?.contains(el) && !dialog.contains(grouped) ? dialog : grouped);
    if (!roots.has(root)) {
      const id = `g${groups.length}`;
      roots.set(root, id);
      groups.push({ id, text: clean((owner ? labelOf(owner) + ': ' : '') + textOf(root)), heading: owner ? labelOf(owner) : textOf(root.querySelector('legend, h1, h2, h3, h4, [role="heading"]'), 300), selected: [] });
    }
    const role = el.getAttribute('role');
    const kind = el.tagName === 'SELECT' ? 'select' : el.matches(OPTION) ? 'option' : el.tagName === 'INPUT' && !el.readOnly && ['text', 'search'].includes(el.type) ? 'fill' : el.matches(DROPDOWN) ? 'dropdown' : el.type === 'checkbox' || role === 'checkbox' || role === 'switch' ? 'checkbox' : el.type === 'radio' || role === 'radio' ? 'radio' : 'click';
    const checked = kind === 'checkbox' || kind === 'radio' ? (el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true') : undefined;
    const group = groups.find(g => g.id === roots.get(root));
    if (checked) group.selected.push({ kind, label: labelOf(el) });
    if (kind === 'fill' && el.value) group.selected.push({ kind, label: labelOf(el), value: el.value.slice(0, 1000) });
    if (kind === 'select') group.selected.push({ kind, label: labelOf(el), options: [...el.selectedOptions].map(option => clean(option.textContent, 180)) });
    const selected = kind === 'option' && (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true');
    if (selected) group.selected.push({ kind, label: labelOf(el) });
    const variants = kind === 'select' ? [...el.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled && !option.parentElement.disabled && (el.multiple || !option.selected)).map(({ option, index }) => ({ optionIndex: index, optionLabel: clean(option.textContent, 180), desiredSelected: !option.selected })) : kind === 'radio' && checked ? [] : [{ ...(kind === 'checkbox' || kind === 'radio' ? { desiredChecked: !checked } : {}), ...(kind === 'dropdown' ? { expanded: el.getAttribute('aria-expanded') === 'true', operation: el.getAttribute('aria-expanded') === 'true' ? 'close' : 'open' } : {}), ...(kind === 'option' ? { selected, dropdown: owner ? labelOf(owner) : undefined } : {}) }];
    for (const variant of variants) {
      if (actions.filter(action => action.group === group.id).length >= 240) { truncated = true; break; }
      const id = `a${actions.length}`;
      const href = el.closest('a[href]')?.href;
      if (href && !/^https?:/i.test(href)) continue;
      const action = { id, group: roots.get(root), kind, label: labelOf(el), ...(kind === 'fill' ? { currentValue: el.value.slice(0, 1000), maxLength: el.maxLength < 0 ? 1000 : Math.min(el.maxLength, 1000), placeholder: clean(el.placeholder, 240) } : {}), ...(checked !== undefined ? { checked } : {}), ...variant, ...(href ? { href } : {}) };
      const item = el.closest('article, li, [role="listitem"]') || localGroupFor(el, controls);
      if (item && item !== root && root.contains(item)) action.context = textOf(item, 320);
      actions.push(action);
      refs.set(id, { el, action, root });
    }
  }
  const headings = [...doc.querySelectorAll('h1, [role="heading"][aria-level="1"]')].filter(visible).slice(0, 3).map(el => textOf(el, 240)).filter(Boolean);
  const publicState = { url: doc.location.href, title: doc.title, headings, text: textOf(dialog || doc.body, 10000), groups, actions, truncated,
    ...(dialog ? { activeDialog: { label: labelOf(dialog), role: dialog.getAttribute('role') || 'dialog' } } : {}) };
  return { publicState, refs };
}

export function execute(ref) {
  const { el, action } = ref;
  if (!el.isConnected || !visible(el) || el.matches(':disabled') || el.closest('[aria-disabled="true"]')) throw new Error('Element nie jest już dostępny.');
  if (!inDialogScope(el, activeDialog(el.ownerDocument)) || !unobscured(el)) throw new Error('Element został zasłonięty przez okno lub nakładkę. Ponów zadanie po zmianie strony.');
  if (action.kind === 'fill') {
    if (el.readOnly || typeof action.value !== 'string' || action.value.length > action.maxLength) throw new Error('Nie można wpisać wartości do pola.');
    const win = el.ownerDocument.defaultView;
    el.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(el, action.value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  } else if (action.kind === 'select') {
    const option = el.options[action.optionIndex];
    if (!option || option.disabled || option.parentElement.disabled || clean(option.textContent, 180) !== action.optionLabel) throw new Error('Lista opcji uległa zmianie.');
    if (el.multiple) option.selected = action.desiredSelected;
    else el.selectedIndex = action.optionIndex;
    const EventClass = el.ownerDocument.defaultView.Event;
    el.dispatchEvent(new EventClass('input', { bubbles: true }));
    el.dispatchEvent(new EventClass('change', { bubbles: true }));
  } else {
    if (action.desiredChecked !== undefined) {
      const current = el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (current === action.desiredChecked) return;
    }
    // Stay in this tab; injected script must be available at the destination.
    const link = el.closest('a[href]');
    const oldTarget = link?.getAttribute('target');
    if (link) link.setAttribute('target', '_self');
    try { el.click(); } finally {
      if (link) oldTarget === null ? link.removeAttribute('target') : link.setAttribute('target', oldTarget);
    }
  }
}
