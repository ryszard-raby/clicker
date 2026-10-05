import { validateConfig, requestBody, componentSummaries, parseDecision, fetchTransport, fingerprint, localSuccess, textRequest, parseText, endpointFor, payloadFor, TEXT_MODEL } from './core.js';
import { scan, execute } from './dom.js';
import { classificationRequest, parseComplexity, planRequest, parsePlan, validateTasks } from './planning.js';

const STORE_KEY = 'clickator.session.v1';
export function sessionStore(doc) {
  return {
    async load() { return JSON.parse(doc.defaultView.sessionStorage.getItem(STORE_KEY) || 'null'); },
    async save(value) { doc.defaultView.sessionStorage.setItem(STORE_KEY, JSON.stringify(value)); },
    async clear() { doc.defaultView.sessionStorage.removeItem(STORE_KEY); },
  };
}

export class Runner {
  constructor(options = {}) {
    this.doc = options.document || document;
    this.transport = options.transport || fetchTransport;
    this.logger = options.logger || null;
    this.debug = options.debug !== false;
    this.console = options.console || this.doc.defaultView.console;
    this.getApiKey = options.getApiKey || (() => options.apiKey || '');
    this.getOpenAIKey = options.getOpenAIKey || (() => options.openaiApiKey || '');
    this.store = options.store || sessionStore(this.doc);
    this.onStatus = options.onStatus || (() => {});
    this.confirm = options.confirm || (async action => this.doc.defaultView.confirm(`Clickator: ${action.label}\n${action.kind === 'fill' ? 'Wpisz: ' + action.value : action.optionLabel || action.href || action.kind}\n${action.context || ''}\nPewność: ${Math.round(action.confidence * 100)}% (próg ${Math.round(action.threshold * 100)}%)\nZezwolić na akcję?`));
    this.running = false;
    this.planning = options.planning !== false;
    this.pending = null;
    this.state = null;
  }
  emit(message) {
    const plan = this.state?.plan;
    this.onStatus(plan && plan.index < plan.tasks.length ? `[${plan.index + 1}/${plan.tasks.length}] ${plan.tasks[plan.index].goal} · ${message}` : message, this.state);
  }
  async stop(reason = 'Zatrzymano przez użytkownika.') {
    this.running = false;
    this.controller?.abort();
    this.pending = null;
    if (this.state) this.state.active = false;
    await this.store.clear();
    this.emit(reason);
  }
  async resume({ allowMissingLogger = false } = {}) {
    if (this.busy) throw new Error('Poczekaj na zakończenie poprzedniej sesji.');
    const state = await this.store.load();
    if (!state?.active) return;
    state.config = validateConfig(state.config);
    if (state.logging && !this.logger) {
      if (!allowMissingLogger) throw new Error('Wybierz ponownie folder logów przed wznowieniem sesji.');
      state.logging = false;
    }
    if (!Array.isArray(state.history) || !Array.isArray(state.seen) || !Number.isInteger(state.steps) || !Number.isFinite(state.startedAt)) throw new Error('Nieprawidłowa zapisana sesja.');
    if (state.plan) {
      validateTasks(state.plan.tasks);
      if (!Number.isInteger(state.plan.index) || state.plan.index < 0 || state.plan.index > state.plan.tasks.length || !Array.isArray(state.plan.completed) || !Number.isInteger(state.plan.replans) || state.plan.replans < 0 || state.plan.replans > 2) throw new Error('Niepoprawna zapisana kolejka.');
    }
    this.state = state;
    return this.run();
  }
  async start(config) {
    if (this.busy) throw new Error('Poczekaj na zakończenie poprzedniej sesji.');
    this.state = { config: validateConfig(config), active: true, steps: 0, startedAt: Date.now(), history: [], seen: [], unchanged: 0, successVotes: 0, requestId: 0, logging: !!this.logger };
    return this.run();
  }
  currentGoal() {
    const task = this.state.plan?.tasks[this.state.plan.index];
    return task ? `${task.goal}\nVisible completion condition: ${task.success}` : this.state.config.goal;
  }
  async checkpointPlan() {
    if (!this.running) return;
    await this.store.save(this.state);
    if (!this.running) await this.store.clear();
  }
  async makePlan(page, reason = null) {
    const previous = this.state.plan;
    if (reason && (previous?.replans || 0) >= 2) {
      await this.stop('Osiągnięto limit dwóch prób ponownego planowania.');
      return false;
    }
    const data = await this.send(planRequest(this.state, page, reason), reason ? 'ponowne planowanie' : 'planowanie');
    if (!this.running) return false;
    const tasks = parsePlan(data);
    this.state.plan = { tasks, index: 0, completed: previous?.completed || [], replans: (previous?.replans || 0) + (reason ? 1 : 0) };
    this.state.classification = 'complex';
    this.state.successVotes = 0;
    this.state.unconfirmedDone = 0;
    this.state.unchanged = 0;
    await this.checkpointPlan();
    this.emit('Plan: ' + tasks.map((task, i) => `${i + 1}. ${task.goal}`).join(' → '));
    return this.running;
  }
  async preparePlan(page) {
    if (!this.planning || this.state.plan || this.state.classification === 'simple') return;
    if (!this.state.classification) {
      const result = await this.send(classificationRequest(this.state.config.goal, page), 'ocena złożoności');
      if (!this.running) return;
      this.state.classification = parseComplexity(result, this.state.config.confidence);
      await this.checkpointPlan();
    }
    if (this.running && this.state.classification === 'complex') await this.makePlan(page);
  }
  async decide(snapshot, componentId = null) {
    const body = requestBody(this.currentGoal(), snapshot, this.state.history, componentId);
    const task = this.state.plan?.tasks[this.state.plan.index];
    if (task) {
      body.state.currentTask = task;
      const scope = ' This request concerns ONLY the currentTask, not the entire multi-step purchase/process. Judge achieved against currentTask.success. Search is complete when matching results are visible; opening, cart and checkout are separate later goals unless explicitly requested in currentTask. Do not require later milestones to confirm this task. Still require visible evidence for its completion.';
      body.questions.next.instructions += scope;
      body.questions.achieved.instructions += scope;
    }
    const stage = componentId === null ? 'wybór komponentu' : 'wybór akcji';
    return this.send(body, stage);
  }
  async send(body, stage) {
    const id = this.state.requestId = (this.state.requestId || 0) + 1;
    let secret = '';
    let http;
    const started = Date.now();
    const diagnostic = (event, details) => {
      if (!this.debug) return;
      // Store snapshots, never credential headers or live objects.
      let serialized = JSON.stringify({ event, session: this.state.startedAt, id, model: body.model, endpoint: endpointFor(body), stage, elapsedMs: Date.now() - started, ...details });
      if (secret) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
      this.console.info('[Clickator API]', JSON.parse(serialized));
    };
    const log = async (kind, value) => {
      if (this.logger) await this.logger.write(`${kind}-${id}.json`, value);
    };
    if (this.logger) this.emit(`Zapisuję log żądania ${id} · ${stage}`);
    await log('request', body);
    await log('response', { status: 'pending' });
    // Preserve numbering if the page is reloaded during the request.
    if (this.logger && this.running) {
      this.emit(`Zapisuję sesję przed żądaniem ${id} · ${stage}`);
      await this.store.save(this.state);
    }
    if (!this.running) { await this.store.clear(); return; }
    const timeout = setTimeout(() => this.controller.abort(), 30000);
    try {
      const apiKey = body.model === TEXT_MODEL ? await this.getOpenAIKey() : await this.getApiKey();
      secret = apiKey;
      if (body.model === TEXT_MODEL && !apiKey) throw new Error('Podaj OPENAI_API_KEY w .env lub klucz OpenAI w panelu.');
      if (this.transport === fetchTransport && !apiKey) throw new Error('Podaj klucz API.');
      // Race also protects against transports that ignore AbortSignal.
      const signal = this.controller.signal;
      if (signal.aborted) throw new Error('Przerwano żądanie.');
      let abort;
      const aborted = new Promise((_, reject) => { abort = () => reject(new Error('Przerwano żądanie lub przekroczono czas.')); signal.addEventListener('abort', abort, { once: true }); });
      try {
        this.emit(`Czekam na odpowiedź ${body.model === TEXT_MODEL ? 'Luna' : 'JEV'} · ${stage} · żądanie ${id} (limit 30 s)`);
        const payload = payloadFor(body);
        diagnostic('request', { bytes: new TextEncoder().encode(JSON.stringify(payload)).length, payload });
        const result = await Promise.race([this.transport(body, { apiKey, signal, onHttp: info => { http = info; diagnostic('http', info); } }), aborted]);
        diagnostic('response', { status: http?.status, response: result });
        if (this.logger && this.running) this.emit(`Zapisuję odpowiedź ${body.model === TEXT_MODEL ? 'Luna' : 'JEV'} · żądanie ${id}`);
        await log('response', result);
        return result;
      } finally { signal.removeEventListener('abort', abort); }
    } catch (error) {
      diagnostic('error', { status: http?.status, message: error.message, response: error.response });
      await log('response', { status: 'error', message: error.message, ...(error.response !== undefined ? { response: error.response } : {}) });
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async approve(action) {
    const signal = this.controller.signal;
    if (signal.aborted) return false;
    let abort;
    const aborted = new Promise(resolve => { abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([this.confirm(action), aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async run() {
    this.busy = true;
    this.running = true;
    this.controller = new AbortController();
    const state = this.state;
    const config = state.config;
    const deadline = state.startedAt + config.maxMinutes * 60000;
    const deadlineTimer = setTimeout(() => { void this.stop('Osiągnięto limit czasu.'); }, Math.max(0, deadline - Date.now()));
    try {
      if (this.logger && !state.requestId) await this.logger.reset();
      await this.preparePlan(scan(this.doc).publicState);
      while (this.running) {
        if (state.plan && state.plan.index === state.plan.tasks.length) return await this.stop('Wszystkie zadania zostały ukończone (ocena modelu).');
        if (Date.now() >= deadline) return await this.stop('Osiągnięto limit czasu.');
        const snapshot = scan(this.doc);
        const page = snapshot.publicState;
        if (localSuccess(config, page, this.doc)) return await this.stop('Cel osiągnięty: spełniono podany warunek.');
        if (state.steps >= config.maxSteps) return await this.stop('Osiągnięto limit kroków.');
        const before = fingerprint(page);
        this.emit(`Analizuję stronę · krok ${state.steps + 1}/${config.maxSteps}${page.truncated ? ' · lista elementów skrócona' : ''}`);
        const data = await this.decide(page);
        if (!this.running) return;
        const components = componentSummaries(page).filter(group => group.actionCount);
        let decision = parseDecision(data, components, config.confidence);
        const componentDecision = decision;
        const component = components.find(group => group.id === decision.choice);
        if (component) {
          const intermediate = scan(this.doc);
          if (fingerprint(intermediate.publicState) !== before || [...snapshot.refs].some(([id, ref]) => intermediate.refs.get(id)?.el !== ref.el)) {
            state.stale = (state.stale || 0) + 1;
            if (state.stale >= 5) return await this.stop('Strona stale się zmienia. Spróbuj ponownie po zakończeniu ładowania.');
            await this.delay();
            continue;
          }
          if (decision.uncertain && config.mode === 'yolo') return await this.stop(`Wstrzymano: pewność wyboru komponentu ${Math.round(decision.confidence * 100)}% poniżej progu ${Math.round(config.confidence * 100)}%.`);
          this.emit(`Wybieram akcję w komponencie: ${component.heading || component.summary}`);
          const actionData = await this.decide(page, component.id);
          if (!this.running) return;
          decision = parseDecision(actionData, page.actions.filter(action => action.group === component.id), config.confidence);
          if (decision.choice === 'done') throw new Error('Etap akcji nie może zakończyć całego celu.');
          decision.confidence = Math.min(componentDecision.confidence, decision.confidence);
          decision.uncertain = decision.confidence < config.confidence;
        }
        // Never execute a decision against a different DOM snapshot.
        const fresh = scan(this.doc);
        if (fingerprint(fresh.publicState) !== before || [...snapshot.refs].some(([id, ref]) => fresh.refs.get(id)?.el !== ref.el)) {
          state.stale = (state.stale || 0) + 1;
          if (state.stale >= 5) return await this.stop('Strona stale się zmienia. Spróbuj ponownie po zakończeniu ładowania.');
          await this.delay();
          continue;
        }
        state.stale = 0;
        const needsConfidenceApproval = decision.uncertain && config.mode === 'manual' && fresh.refs.has(decision.choice);
        if (decision.uncertain && !needsConfidenceApproval) return await this.stop(`Wstrzymano: pewność ${Math.round(decision.confidence * 100)}% poniżej progu ${Math.round(config.confidence * 100)}%. Zmień próg w panelu lub użyj trybu manualnego, aby zatwierdzać niepewne akcje.`);
        if (decision.choice === 'blocked') {
          if (this.planning) {
            if (await this.makePlan(page, 'JEV selected blocked: cannot continue the current goal with available actions.')) continue;
            return;
          }
          return await this.stop('JEV nie znalazł kolejnej akcji. Potrzebna interwencja użytkownika.');
        }
        if (decision.choice === 'done') {
          if (config.success && (!state.plan || state.plan.index === state.plan.tasks.length - 1)) return await this.stop('JEV sugeruje koniec, ale podany warunek sukcesu nie został spełniony.');
          const completionThreshold = config.confidence;
          if (decision.achieved < completionThreshold) {
            if (!state.plan) return await this.stop('Nie można potwierdzić osiągnięcia celu.');
            state.successVotes = 0;
            state.unconfirmedDone = (state.unconfirmedDone || 0) + 1;
            if (state.unconfirmedDone >= 2) {
              return await this.stop(`JEV nie potwierdził ukończenia: ocena ${Math.round(decision.achieved * 100)}%, wymagane ${Math.round(completionThreshold * 100)}%.`);
            }
            this.emit(`Ponownie sprawdzam ukończenie podcelu: ocena ${Math.round(decision.achieved * 100)}%, wymagane ${Math.round(completionThreshold * 100)}%.`);
            await this.checkpointPlan();
            await this.delay();
            continue;
          }
          state.unconfirmedDone = 0;
          state.successVotes++;
          if (state.successVotes >= 2) {
            if (state.plan) {
              state.plan.completed.push(state.plan.tasks[state.plan.index]);
              state.plan.index++;
              state.successVotes = 0;
              state.unchanged = 0;
              await this.checkpointPlan();
              if (!this.running) return;
              if (state.plan.index < state.plan.tasks.length) continue;
            }
            return await this.stop('JEV dwukrotnie ocenił cel jako osiągnięty (ocena modelu).');
          }
          this.emit('Weryfikuję zakończenie drugim odczytem strony…');
          await this.delay();
          continue;
        }
        state.successVotes = 0;
        const ref = fresh.refs.get(decision.choice);
        const action = ref.action;
        if (action.kind === 'fill') {
          const generated = await this.send(textRequest(this.currentGoal(), page, action), 'generowanie wartości pola');
          if (!this.running) return;
          const check = scan(this.doc);
          if (fingerprint(check.publicState) !== before || check.refs.get(action.id)?.el !== ref.el) {
            state.textStale = (state.textStale || 0) + 1;
            if (state.textStale >= 5) return await this.stop('Pole zmieniło się podczas generowania tekstu.');
            continue;
          }
          state.textStale = 0;
          action.value = parseText(generated, action);
        }
        const signature = JSON.stringify([before, action]);
        if (state.seen.filter(x => x === signature).length >= 2) return await this.stop('Wykryto pętlę: powtarzana akcja w tym samym stanie strony.');
        if (config.mode === 'manual' && (needsConfidenceApproval || !['checkbox', 'radio'].includes(action.kind))) {
          this.emit(`Czekam na zgodę: ${action.label}${needsConfidenceApproval ? ` · pewność ${Math.round(decision.confidence * 100)}%, próg ${Math.round(config.confidence * 100)}%` : ''}`);
          const approved = await this.approve({ ...action, confidence: decision.confidence, threshold: config.confidence, context: page.groups.find(group => group.id === action.group)?.text || '' });
          if (!this.running) return;
          if (!approved) return await this.stop('Akcja odrzucona.');
          const afterApproval = scan(this.doc);
          if (fingerprint(afterApproval.publicState) !== before || afterApproval.refs.get(action.id)?.el !== ref.el) continue;
        }
        if (!this.running || Date.now() >= deadline) return;
        state.steps++;
        state.seen.push(signature);
        state.seen = state.seen.slice(-10);
        state.history.push({ url: page.url, component: component?.heading || component?.summary, action, step: state.steps });
        state.history = state.history.slice(-12);
        // Checkpoint BEFORE clicking: a full navigation can destroy this context.
        this.emit(`Zapisuję sesję przed wykonaniem: ${action.label}`);
        await this.store.save(state);
        if (!this.running) { await this.store.clear(); return; }
        this.emit(`Wykonuję: ${action.label}${action.optionLabel ? ' → ' + action.optionLabel : ''}`);
        execute(ref);
        this.emit(action.kind === 'fill' ? `Wpisano tekst: ${action.label} · czekam na sugestie autocomplete` : `Wysłano akcję: ${action.label} · czekam na zmianę strony`);
        await this.delay(action.kind === 'fill' ? Math.max(config.settleMs, config.autocompleteMs) : config.settleMs);
        if (!this.running) return;
        const after = fingerprint(scan(this.doc).publicState);
        state.unchanged = before === after ? state.unchanged + 1 : 0;
        if (state.unchanged >= 2) return await this.stop('Brak widocznego postępu po dwóch akcjach.');
      }
    } catch (error) {
      if (this.running) await this.stop(`Błąd: ${error.message}`);
    } finally {
      clearTimeout(deadlineTimer);
      this.running = false;
      this.busy = false;
    }
  }
  delay(duration = this.state.config.settleMs) {
    const signal = this.controller.signal;
    return new Promise(resolve => {
      const started = Date.now();
      let timer;
      let limit;
      let observer;
      const finish = () => { clearTimeout(timer); clearTimeout(limit); observer?.disconnect(); signal.removeEventListener('abort', finish); resolve(); };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(finish, Math.max(200, duration - (Date.now() - started)));
      };
      if (this.doc.defaultView.MutationObserver) {
        observer = new this.doc.defaultView.MutationObserver(records => {
          if (records.some(record => {
            const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            return !el?.closest('[data-clickator-root]');
          })) schedule();
        });
        observer.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      schedule();
      // Animated banners and clocks must not keep the runner waiting forever.
      limit = setTimeout(finish, Math.max(duration, 2000));
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
