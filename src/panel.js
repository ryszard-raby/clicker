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
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:14px/1.45 system-ui;color:#e9eef8}*{box-sizing:border-box}section{width:340px;max-width:calc(100vw - 36px);max-height:85vh;overflow:auto;background:#141c2d;border:1px solid #384762;border-radius:16px;padding:18px;box-shadow:0 15px 60px #0005}header{display:flex;align-items:center;justify-content:space-between}h2{font-size:19px;margin:0}small{color:#aabbd2}label{display:block;margin-top:12px}input,textarea,select,button{font:inherit}input,textarea,select{display:block;width:100%;background:#202c43;color:#fff;border:1px solid #495772;border-radius:7px;padding:8px;margin-top:5px}textarea{resize:vertical;min-height:76px}button{cursor:pointer;border:0;border-radius:7px;padding:8px 12px;background:#89f0c5;color:#10261d;font-weight:650}button:disabled{opacity:.4;cursor:default}.row{display:flex;gap:8px;margin-top:14px}.row>*{flex:1}.secondary{background:#34415a;color:#fff}p{margin:12px 0 0;font-size:12px;color:#b9c8de}output{display:block;margin-top:14px;color:#89f0c5;overflow-wrap:anywhere}[hidden]{display:none!important}details{margin-top:12px}#approval{border:1px solid #e3b862;border-radius:8px;padding:10px;margin-top:12px}#action{white-space:pre-wrap;overflow-wrap:anywhere}
    </style><section aria-label="Clickator"><header><h2>Clickator</h2><small>JEV 1.13</small></header>
    <label>Cel<textarea id="goal" placeholder="Zaznacz poprawne odpowiedzi na wszystkie pytania quizu."></textarea></label>
    <label id="keyLabel">Klucz DefAPI<input id="key" type="password" autocomplete="off" placeholder="Tylko w pamięci tej strony"></label>
    <label>Tryb<select id="mode"><option value="manual">Manualny · potwierdzaj klikanie</option><option value="yolo">YOLO · działaj automatycznie</option></select></label>
    <details><summary>Warunek sukcesu i limity</summary><label>Sukces<select id="successType"><option value="">Ocena JEV (dwa potwierdzenia)</option><option value="text">Widoczny tekst zawiera</option><option value="url">Adres URL zawiera</option><option value="selector">Widoczny selektor CSS</option></select></label><input id="successValue" aria-label="Wartość warunku sukcesu"><div class="row"><label>Kroki<input id="steps" type="number" min="1" max="500" value="40"></label><label>Minuty<input id="minutes" type="number" min="1" max="60" value="5"></label></div></details>
    <label>Minimalna pewność decyzji (%)<input id="confidence" type="number" min="0" max="100" step="1" value="70"></label>
    <p>Poniżej progu: manualny pyta o zgodę na akcję, YOLO zatrzymuje sesję. Niższy próg dopuszcza mniej pewne decyzje. Zmiana dotyczy następnego Start.</p>
    <p>Do DefAPI trafia tekst strony i opisy elementów. Manualny automatycznie zmienia checkboxy i odpowiedzi radiowe powyżej progu. YOLO również klika i nawiguje.</p>
    <div class="row"><button id="logs" class="secondary">Wybierz folder logów</button></div><small id="logStatus">Zapis logów wyłączony. Start nadpisuje logi poprzedniej sesji.</small>
    <div class="row"><button id="start">Start</button><button id="stop" class="secondary" disabled>Stop</button><button id="resume" class="secondary" hidden>Wznów</button></div>
    <div id="approval" hidden><div id="action"></div><div class="row"><button id="yes">Zezwól</button><button id="no" class="secondary">Odrzuć</button></div></div>
    <output id="status" role="status">Gotowy.</output></section>`;
  doc.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  let resolver;
  const runner = new Runner({ ...options, document: doc,
    getApiKey: options.getApiKey || (() => options.apiKey || $('key').value),
    confirm: options.confirm || (action => new Promise(resolve => {
      resolver = resolve;
      $('approval').hidden = false;
      $('action').textContent = `${action.label}\n${action.desiredChecked === undefined ? '' : action.desiredChecked ? 'Zaznacz\n' : 'Odznacz\n'}${action.optionLabel || action.href || action.kind}\n${action.context || ''}\nPewność: ${Math.round(action.confidence * 100)}% · próg: ${Math.round(action.threshold * 100)}%`;
    })),
    onStatus(message, state) {
      $('status').textContent = message;
      const active = !!state?.active;
      $('start').disabled = active;
      $('stop').disabled = !active;
      $('logs').disabled = active;
      if (!active) { $('approval').hidden = true; resolver?.(false); resolver = null; }
      options.onStatus?.(message, state);
    },
  });
  if (options.getApiKey || options.apiKey) $('keyLabel').hidden = true;
  const approve = value => { $('approval').hidden = true; resolver?.(value); resolver = null; };
  $('yes').onclick = () => approve(true);
  $('no').onclick = () => approve(false);
  const report = error => { $('status').textContent = error.message; };
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
    $('resume').hidden = true;
    void runner.start({ goal: $('goal').value, mode: $('mode').value, confidence: $('confidence').valueAsNumber / 100, maxSteps: Number($('steps').value), maxMinutes: Number($('minutes').value), success: $('successType').value ? { type: $('successType').value, value: $('successValue').value } : null }).catch(report);
  };
  $('stop').onclick = () => { void runner.stop().catch(report); };
  const resume = () => {
    $('resume').hidden = true;
    return runner.resume({ allowMissingLogger: true });
  };
  $('resume').onclick = () => { void resume().catch(report); };
  runner.store.load().then(saved => {
    if (!saved?.active || runner.running) return;
    $('goal').value = saved.config.goal;
    $('mode').value = saved.config.mode;
    $('confidence').value = (saved.config.confidence ?? 0.7) * 100;
    $('steps').value = saved.config.maxSteps;
    $('minutes').value = saved.config.maxMinutes;
    $('successType').value = saved.config.success?.type || '';
    $('successValue').value = saved.config.success?.value || '';
    if (saved.logging && !runner.logger) $('logStatus').textContent = 'Po przeładowaniu kontynuuję bez zapisu logów do folderu. Aby włączyć zapis, zatrzymaj zadanie i wybierz folder ponownie.';
    if (options.autoResume && canAutoResume) void resume().catch(report);
    else { $('resume').hidden = false; $('status').textContent = 'Zapisana sesja. Kliknij Wznów; jeśli potrzeba, uzupełnij klucz API.'; }
  }).catch(report);
  return runner;
}
