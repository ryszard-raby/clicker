import { endpointFor, payloadFor } from './core.js';

export function gmTransport(xmlhttpRequest) {
  return (body, { apiKey, signal, onHttp }) => new Promise((resolve, reject) => {
    if (!apiKey) { reject(new Error('Brak klucza API.')); return; }
    if (signal.aborted) { reject(new Error('Przerwano.')); return; }
    let request;
    const abort = () => { request?.abort(); fail(new Error('Przerwano.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = error => { cleanup(); reject(error); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      request = xmlhttpRequest({
        method: 'POST', url: endpointFor(body),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        data: JSON.stringify(payloadFor(body)), timeout: 30000,
        onload(response) {
          cleanup();
          onHttp?.({ status: response.status, response: response.responseText, requestId: response.responseHeaders?.match(/^x-request-id:\s*(.+)$/im)?.[1]?.trim(), ray: response.responseHeaders?.match(/^cf-ray:\s*(.+)$/im)?.[1]?.trim() });
          if (response.status < 200 || response.status >= 300) { reject(Object.assign(new Error(`API HTTP ${response.status} · model ${body.model}`), { response: response.responseText })); return; }
          try { resolve(JSON.parse(response.responseText)); } catch { reject(Object.assign(new Error(`API zwróciło niepoprawny JSON · model ${body.model}`), { response: response.responseText })); }
        },
        onerror: (response = {}) => {
          const endpoint = endpointFor(body);
          const host = new URL(endpoint).hostname;
          const details = { event: 'network-error', endpoint, model: body.model, status: response.status ?? 0, statusText: response.statusText || '', error: String(response.error || '') };
          // Never serialize the whole GM response: it may include request headers.
          const safe = JSON.stringify(details).split(apiKey).join('[REDACTED]');
          onHttp?.(JSON.parse(safe));
          fail(Object.assign(new Error(`Brak połączenia z ${host} · model ${body.model}. Sprawdź @connect ${host} w zainstalowanym userscripcie oraz połączenie sieciowe.`), { response: safe }));
        },
        ontimeout: () => fail(new Error('Przekroczono czas żądania API.')),
        onabort: () => fail(new Error('Przerwano żądanie API.')),
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
