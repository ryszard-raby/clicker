import { Runner } from './runtime.js';
import { directoryLogger } from './logging.js';
import { gmTransport, gmTabStore } from './tampermonkey.js';

export function mount(options = {}) {
  options = { autoResume: true, ...options };
  const canAutoResume = !!(options.getApiKey || options.apiKey || options.transport);
  if (!options.store && typeof GM_getTab === 'function' && typeof GM_saveTab === 'function') options.store = gmTabStore(GM_getTab, GM_saveTab);
  if (!options.transport && typeof GM_xmlhttpRequest === 'function') options.transport = gmTransport(GM_xmlhttpRequest);
  const doc = options.document || document;
  if (doc.querySelector('[data-clickator-root]')) throw new Error('Panel Clickator jest już otwarty.');
  const host = doc.createElement('div');
  host.dataset.clickatorRoot = '';
  host.style.cssText = 'position:fixed;left:50%;bottom:max(24px, env(safe-area-inset-bottom));transform:translateX(-50%);width:min(720px, calc(100vw - 32px));z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#262536;color-scheme:light}*{box-sizing:border-box}[hidden]{display:none!important}
    section{position:relative;width:100%}button,input,textarea,select{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;border:0;border-radius:12px;padding:10px 16px;background:#7560db;color:#fff;font-weight:600;transition:background .16s,box-shadow .16s}button:hover{background:#624dcc}button:disabled{opacity:.4;cursor:default}button:focus-visible,summary:focus-visible{outline:3px solid #a99aee;outline-offset:3px}svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.secondary{background:#f0eef6;color:#565066}.secondary:hover{background:#e7e3f2}
    .composer{display:flex;align-items:center;gap:10px;padding:10px;background:#fffffff5;border:1px solid #e7e4ef;border-radius:28px;box-shadow:0 12px 48px #24203a20,0 2px 8px #24203a0a;backdrop-filter:blur(18px);transition:box-shadow .2s,border-color .2s}.composer:focus-within{border-color:#b8abea;box-shadow:0 12px 48px #24203a20,0 0 0 3px #b7a6ed22}.brand{display:grid;place-items:center;width:38px;height:38px;margin-left:4px;border-radius:14px;background:#f0ecfc;color:#8872d6;flex-shrink:0}.brand svg{width:21px;height:21px}
    #goal{display:block;flex:1;min-width:0;height:44px;max-height:132px;padding:11px 0;margin:0;resize:none;border:0;background:transparent;color:#262536;outline:none;line-height:22px;scrollbar-width:thin}#goal::placeholder{color:#92909f}.icon-button{padding:0;width:44px;height:44px;flex-shrink:0;border-radius:50%}#settingsToggle{background:transparent;color:#93909f}#settingsToggle:hover,#settingsToggle[aria-expanded="true"]{background:#f0ecfc;color:#7560db}#start{background:#282535}#start:hover{background:#4d4269}#stop{background:#fff0ed;color:#c15947}.divider{width:1px;height:24px;background:#ece9f2;flex-shrink:0}#resume{font-size:12px;padding:10px 12px;flex-shrink:0}
    .popover{position:absolute;right:0;bottom:calc(100% + 14px);width:400px;max-width:100%;max-height:min(640px,calc(100dvh - 130px));overflow:auto;overscroll-behavior:contain;background:#fff;border:1px solid #e7e4ef;border-radius:22px;padding:22px;box-shadow:0 16px 64px #24203a26;scrollbar-width:thin}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:16px;letter-spacing:-.3px;margin:0}small{font-size:11px;color:#93909f}.eyebrow{display:block;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#9b8acb;margin-bottom:3px}#settingsClose{width:30px;height:30px;background:transparent;color:#8d889b}label{display:block;margin-top:16px;font-size:12px;font-weight:550;color:#625d72}input,select{display:block;width:100%;min-width:0;background:#f8f7fb;color:#373244;border:1px solid #e5e1ed;border-radius:10px;padding:10px;margin-top:6px;outline:none}input:focus,select:focus{border-color:#a390df;box-shadow:0 0 0 3px #b7a6ed22}.row{display:flex;gap:10px;margin-top:14px}.row>*{flex:1;min-width:0}.row label{margin-top:0}p{margin:10px 0 0;font-size:11px;line-height:1.6;color:#9690a2}details{margin-top:16px;border-top:1px solid #eeebf3;padding-top:16px}summary{cursor:pointer;font-size:12px;color:#625d72}#logStatus{display:block;margin-top:8px;line-height:1.6}.settings-footer{margin-top:18px;padding-top:14px;border-top:1px solid #eeebf3}
    .feedback{position:absolute;bottom:calc(100% + 14px);left:0;right:0;max-height:calc(100dvh - 130px);overflow:auto;background:#fffffff5;border:1px solid #e7e4ef;border-radius:18px;box-shadow:0 8px 32px #24203a12;padding:12px 16px;backdrop-filter:blur(18px)}output{display:block;font-size:12px;color:#6e647e;overflow-wrap:anywhere}#approval{margin-top:12px;border-top:1px solid #ede8f5;padding-top:12px}#action{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}section:has(#settings:not([hidden])) .feedback{display:none}.hint{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
    @media(max-width:480px){.composer{gap:6px;padding:8px;border-radius:25px}.brand{display:none}.icon-button{width:40px;height:40px}#goal{font-size:13px}.popover{padding:18px}.divider{display:none}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
    </style><section aria-label="Clickator">
    <div id="feedback" class="feedback" hidden><output id="status" role="status">Gotowy.</output><div id="approval" hidden><div id="action"></div><div class="row"><button id="yes">Zezwól</button><button id="no" class="secondary">Odrzuć</button></div></div></div>
    <div id="settings" class="popover" role="region" aria-labelledby="settingsTitle" hidden>
    <header><div><span class="eyebrow">Clickator · JEV 1.13</span><h2 id="settingsTitle">Ustawienia</h2></div><button id="settingsClose" class="icon-button" aria-label="Zamknij ustawienia" title="Zamknij ustawienia"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
    <label id="keyLabel">Klucz TypeSafe<input id="key" type="password" autocomplete="off" placeholder="Tylko w pamięci tej strony"></label>
    <label id="openaiKeyLabel">Klucz OpenAI (Luna)<input id="openaiKey" type="password" autocomplete="off" placeholder="OPENAI_API_KEY lub klucz tutaj"></label>
    <label>Tryb<select id="mode"><option value="manual">Manualny · potwierdzaj klikanie</option><option value="yolo" selected>YOLO · działaj automatycznie</option></select></label>
    <details><summary>Warunek sukcesu i limity</summary><label>Sukces<select id="successType"><option value="">Ocena JEV (dwa potwierdzenia)</option><option value="text">Widoczny tekst zawiera</option><option value="url">Adres URL zawiera</option><option value="selector">Widoczny selektor CSS</option></select></label><input id="successValue" aria-label="Wartość warunku sukcesu"><div class="row"><label>Kroki<input id="steps" type="number" min="1" max="500" value="40"></label><label>Minuty<input id="minutes" type="number" min="1" max="60" value="5"></label></div></details>
    <label>Próg decyzji i ukończenia celu (%)<input id="confidence" type="number" min="0" max="100" step="1" value="20"></label>
    <p>Poniżej progu: manualny pyta o zgodę na akcję, YOLO zatrzymuje sesję. Niższy próg dopuszcza mniej pewne decyzje. Zmiana dotyczy następnego Start.</p>
    <p>Do TypeSafe trafia tekst strony i opisy elementów. Manualny automatycznie zmienia checkboxy i odpowiedzi radiowe powyżej progu. YOLO również klika i nawiguje.</p>
    <div class="row"><button id="logs" class="secondary">Wybierz folder logów</button></div><small id="logStatus">Zapis logów wyłączony. Start nadpisuje logi poprzedniej sesji.</small>
    <div class="settings-footer"><small>Enter — rozpocznij · Shift+Enter — nowa linia</small></div></div>
    <div class="composer">
    <span class="brand" title="Clickator" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"/></svg></span>
    <textarea id="goal" rows="1" aria-label="Polecenie dla Clickatora" aria-describedby="goalHint" placeholder="Co chcesz zrobić na tej stronie?"></textarea><span id="goalHint" class="hint">Enter rozpoczyna zadanie. Shift+Enter dodaje nową linię.</span>
    <button id="resume" class="secondary" hidden>Wznów</button>
    <button id="settingsToggle" class="icon-button" aria-label="Ustawienia" aria-expanded="false" aria-controls="settings" title="Ustawienia"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.6 2.2-2 .9-2.1-.6-2.5 4.3 1.5 1.6v2.3l-1.5 1.5 2.5 4.3 2.1-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2.1.6 2.5-4.3-1.5-1.5v-2.3l1.5-1.6-2.5-4.3-2.1.6-2-.9L14.5 3Z"/><circle cx="12" cy="12" r="3"/></svg></button>
    <span class="divider" aria-hidden="true"></span>
    <button id="start" class="icon-button" aria-label="Rozpocznij zadanie" title="Rozpocznij · Enter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
    <button id="stop" class="icon-button" aria-label="Zatrzymaj zadanie" title="Zatrzymaj" disabled hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg></button>
    </div></section>`;
  doc.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  const setSettings = (open, restoreFocus = false) => {
    $('settings').hidden = !open;
    $('settingsToggle').setAttribute('aria-expanded', String(open));
    if (open) $('settingsClose').focus();
    else if (restoreFocus) $('settingsToggle').focus();
  };
  $('settingsToggle').onclick = () => setSettings($('settings').hidden);
  $('settingsClose').onclick = () => setSettings(false, true);
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('settings').hidden) {
      event.preventDefault();
      event.stopPropagation();
      setSettings(false, true);
    }
  });
  $('goal').addEventListener('focus', () => setSettings(false));
  const resizeGoal = () => {
    $('goal').style.height = '44px';
    $('goal').style.height = `${Math.max(44, Math.min(132, $('goal').scrollHeight))}px`;
  };
  $('goal').addEventListener('input', resizeGoal);
  const preferencesKey = 'clickator.preferences.v1';
  let savedConfidence = 20;
  try {
    const saved = typeof GM_getValue === 'function'
      ? GM_getValue(preferencesKey, null)
      : JSON.parse(doc.defaultView.localStorage.getItem(preferencesKey) || 'null');
    if (typeof saved?.goal === 'string') $('goal').value = saved.goal;
    if (Number.isFinite(saved?.confidence) && saved.confidence >= 0 && saved.confidence <= 100) {
      savedConfidence = saved.confidence;
      $('confidence').value = savedConfidence;
    }
  } catch { /* Storage may be unavailable on this page. */ }
  resizeGoal();
  const savePreferences = () => {
    const confidence = $('confidence').valueAsNumber;
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 100) savedConfidence = confidence;
    const saved = { goal: $('goal').value, confidence: savedConfidence };
    try {
      if (typeof GM_setValue === 'function') GM_setValue(preferencesKey, saved);
      else doc.defaultView.localStorage.setItem(preferencesKey, JSON.stringify(saved));
    } catch { /* A storage failure must not prevent starting the task. */ }
  };
  $('goal').addEventListener('input', savePreferences);
  $('confidence').addEventListener('input', savePreferences);
  let resolver;
  const runner = new Runner({ ...options, document: doc,
    getApiKey: options.getApiKey || (() => options.apiKey || $('key').value),
    getOpenAIKey: options.getOpenAIKey || (() => options.openaiApiKey || $('openaiKey').value),
    confirm: options.confirm || (action => new Promise(resolve => {
      resolver = resolve;
      setSettings(false);
      $('feedback').hidden = false;
      $('approval').hidden = false;
      $('action').textContent = `${action.label}\n${action.desiredChecked === undefined ? '' : action.desiredChecked ? 'Zaznacz\n' : 'Odznacz\n'}${action.kind === 'fill' ? 'Wpisz: ' + action.value : action.optionLabel || action.href || action.kind}\n${action.context || ''}\nPewność: ${Math.round(action.confidence * 100)}% · próg: ${Math.round(action.threshold * 100)}%`;
    })),
    onStatus(message, state) {
      $('status').textContent = message;
      $('feedback').hidden = false;
      const active = !!state?.active;
      $('start').disabled = active;
      $('start').hidden = active;
      $('stop').disabled = !active;
      $('stop').hidden = !active;
      $('logs').disabled = active;
      if (!active) { $('approval').hidden = true; resolver?.(false); resolver = null; }
      options.onStatus?.(message, state);
    },
  });
  if (options.getApiKey || options.apiKey) $('keyLabel').hidden = true;
  if (options.getOpenAIKey || options.openaiApiKey) $('openaiKeyLabel').hidden = true;
  const approve = value => { $('approval').hidden = true; resolver?.(value); resolver = null; };
  $('yes').onclick = () => approve(true);
  $('no').onclick = () => approve(false);
  const report = error => { setSettings(false); $('feedback').hidden = false; $('status').textContent = error.message; };
  if (options.logger) $('logStatus').textContent = 'Zapis logów włączony przez konfigurację.';
  $('logs').onclick = async () => {
    if (runner.busy) return;
    try {
      if (!doc.defaultView.showDirectoryPicker) throw new Error('Ta przeglądarka lub kontekst skryptu nie udostępnia wyboru folderu. Użyj Chrome/Edge na HTTPS lub przekaż własny logger.');
      $('start').disabled = true;
      $('resume').disabled = true;
      const parent = await doc.defaultView.showDirectoryPicker({ id: 'clickator-logs', mode: 'readwrite' });
      const directory = await parent.getDirectoryHandle('clickator-logs', { create: true });
      runner.logger = directoryLogger(directory);
      $('logStatus').textContent = `Logi: ${parent.name}/clickator-logs. Start nadpisuje poprzednią sesję.`;
    } catch (error) { if (error.name !== 'AbortError') report(error); }
    finally { $('start').disabled = runner.busy; $('resume').disabled = false; }
  };
  $('start').onclick = () => {
    setSettings(false);
    savePreferences();
    $('resume').hidden = true;
    void runner.start({ goal: $('goal').value, mode: $('mode').value, confidence: $('confidence').valueAsNumber / 100, maxSteps: Number($('steps').value), maxMinutes: Number($('minutes').value), success: $('successType').value ? { type: $('successType').value, value: $('successValue').value } : null }).catch(report);
  };
  $('stop').onclick = () => { void runner.stop().catch(report); };
  $('goal').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !runner.busy && !$('start').disabled && $('goal').value.trim()) $('start').click();
  });
  const resume = () => {
    $('resume').hidden = true;
    return runner.resume({ allowMissingLogger: true });
  };
  $('resume').onclick = () => { void resume().catch(report); };
  runner.store.load().then(saved => {
    if (!saved?.active || runner.running) return;
    $('goal').value = saved.config.goal;
    resizeGoal();
    $('mode').value = saved.config.mode;
    $('confidence').value = (saved.config.confidence ?? 0.2) * 100;
    $('steps').value = saved.config.maxSteps;
    $('minutes').value = saved.config.maxMinutes;
    $('successType').value = saved.config.success?.type || '';
    $('successValue').value = saved.config.success?.value || '';
    if (saved.logging && !runner.logger) $('logStatus').textContent = 'Po przeładowaniu kontynuuję bez zapisu logów do folderu. Aby włączyć zapis, zatrzymaj zadanie i wybierz folder ponownie.';
    if (options.autoResume && canAutoResume) void resume().catch(report);
    else { $('resume').hidden = false; $('feedback').hidden = false; $('status').textContent = 'Zapisana sesja. Kliknij Wznów; jeśli potrzeba, uzupełnij klucz API w ustawieniach.'; }
  }).catch(report);
  return runner;
}
