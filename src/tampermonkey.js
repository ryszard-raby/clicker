import { ENDPOINT } from './core.js';

export function gmTransport(xmlhttpRequest) {
  return (body, { apiKey, signal }) => new Promise((resolve, reject) => {
    if (!apiKey) { reject(new Error('Brak klucza API.')); return; }
    if (signal.aborted) { reject(new Error('Przerwano.')); return; }
    let request;
    const abort = () => { request?.abort(); fail(new Error('Przerwano.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = error => { cleanup(); reject(error); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      request = xmlhttpRequest({
        method: 'POST', url: ENDPOINT,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        data: JSON.stringify(body), timeout: 30000,
        onload(response) {
          cleanup();
          if (response.status < 200 || response.status >= 300) { reject(Object.assign(new Error(`JEV HTTP ${response.status}`), { response: response.responseText })); return; }
          try { resolve(JSON.parse(response.responseText)); } catch { reject(Object.assign(new Error('JEV zwrócił niepoprawny JSON.'), { response: response.responseText })); }
        },
        onerror: () => fail(new Error('Nie udało się połączyć z DefAPI.')),
        ontimeout: () => fail(new Error('Przekroczono czas żądania DefAPI.')),
        onabort: () => fail(new Error('Przerwano żądanie DefAPI.')),
      });
    } catch (error) { fail(error); }
  });
}

export function gmTabStore(getTab, saveTab) {
  const loadTab = () => new Promise(resolve => getTab(resolve));
  const write = tab => new Promise(resolve => saveTab(tab, resolve));
  let queue = Promise.resolve();
  const mutate = fn => {
    queue = queue.catch(() => {}).then(async () => { const tab = await loadTab(); fn(tab); await write(tab); });
    return queue;
  };
  return {
    async load() { await queue; return (await loadTab()).clickatorSession || null; },
    save(state) { const copy = JSON.parse(JSON.stringify(state)); return mutate(tab => { tab.clickatorSession = copy; }); },
    clear() { return mutate(tab => { delete tab.clickatorSession; }); },
  };
}
