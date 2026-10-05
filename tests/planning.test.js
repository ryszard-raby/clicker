import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Runner } from '../src/runtime.js';
import { TEXT_MODEL } from '../src/core.js';
import { parsePlan, planRequest } from '../src/planning.js';

const decision = (choice) => ({ answers: { next: { type: 'choice', choice, confidence: 1 }, achieved: { type: 'noul', noul: choice === 'done' ? 1 : 0 } } });
const complexity = (choice) => ({ answers: { complexity: { type: 'choice', choice, confidence: 1 } } });
const completion = tasks => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ tasks }) } }] });
const task = goal => ({ goal, success: `${goal} visible` });

test('configured confidence controls both intermediate and final success', async () => {
  for (const threshold of [0.2, 0.65, 0.8]) {
    let llmCalls = 0;
    const { runner } = setup(async body => {
      if (body.model === TEXT_MODEL) { llmCalls++; return completion([task('Search X'), task('Open X')]); }
      if (body.state.stage === 'classification') return complexity('complex');
      const result = decision('done');
      result.answers.achieved.noul = 0.65;
      return result;
    });
    await runner.start({ goal: 'Search and open X', confidence: threshold, taskSuccessThreshold: 0.8, successThreshold: 0.97 });
    assert.equal(llmCalls, 1, 'Luna is called only to create the plan');
    assert.equal(runner.state.plan.completed.length, threshold <= 0.65 ? 2 : 0);
    assert.equal(runner.state.plan.replans, 0);
  }
});

test('uncertain subgoal completion is checked again without skipping the goal', async () => {
  let checks = 0;
  const { runner } = setup(async body => {
    if (body.model === TEXT_MODEL) return completion([task('Search X')]);
    if (body.state.stage === 'classification') return complexity('complex');
    assert.equal(body.state.currentTask.goal, 'Search X');
    assert.match(body.questions.achieved.instructions, /ONLY the currentTask/);
    const result = decision('done');
    result.answers.achieved.noul = ++checks === 1 ? 0.85 : 1;
    return result;
  });
  await runner.start({ goal: 'Search X', confidence: 0.97 });
  assert.equal(checks, 3);
  assert.equal(runner.state.plan.completed.length, 1);
  assert.equal(runner.state.plan.replans, 0);
});

test('uncertain final success stops without pointless replanning', async () => {
  let plans = 0, checks = 0;
  const { runner } = setup(async body => {
    if (body.model === TEXT_MODEL) {
      if (plans++) {
        const input = JSON.parse(body.messages[1].content);
        assert.match(input.reason, /could not verify/);
        assert.equal(input.completed.length, 0);
      }
      return completion([task('Search X')]);
    }
    if (body.state.stage === 'classification') return complexity('complex');
    checks++;
    const result = decision('done');
    result.answers.achieved.noul = 0.85;
    return result;
  });
  await runner.start({ goal: 'Search X', confidence: 0.97 });
  assert.equal(plans, 1);
  assert.equal(checks, 2);
  assert.equal(runner.state.plan.completed.length, 0);
});

test('empty planner response has a useful explanation instead of a schema error', () => {
  assert.throws(() => parsePlan(completion([])), /pusty plan bez uzasadnienia/);
  const response = completion([]);
  response.choices[0].message.content = JSON.stringify({ tasks: [], blockedReason: 'Podaj nazwę produktu.' });
  assert.throws(() => parsePlan(response), /Podaj nazwę produktu/);
});

test('planner can begin product discovery before purchase details are known', () => {
  const body = planRequest({ config: { goal: 'kup czarną bluzę' }, history: [] }, { text: 'Kategorie Szukaj', title: 'Sklep' });
  assert.match(body.messages[0].content, /must not prevent searching/);
  assert.match(body.messages[0].content, /Keep the full requested outcome/);
  assert.ok(body.response_format.json_schema.schema.required.includes('blockedReason'));
  assert.deepEqual(parsePlan(completion([task('Wyszukaj czarną bluzę')])), [task('Wyszukaj czarną bluzę')]);
});
function setup(transport, options = {}) {
  const dom = new JSDOM('<button>Open</button><p id="result"></p>', { url: 'https://example.org' });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100 }];
  let saved;
  const store = { async save(value) { saved = structuredClone(value); }, async load() { return saved; }, async clear() { saved = null; } };
  const runner = new Runner({ document: dom.window.document, store, transport, debug: false, openaiApiKey: 'test', ...options });
  runner.delay = async () => {};
  return { runner, store, doc: dom.window.document };
}

test('simple goal uses unchanged component/action loop without planner', async () => {
  const stages = [];
  const { runner, doc } = setup(async body => {
    stages.push(body.state.stage);
    if (body.state.stage === 'classification') return complexity('simple');
    return decision(body.state.stage === 'component' ? (doc.querySelector('#result').textContent ? 'done' : 'g0') : 'a0');
  });
  doc.querySelector('button').onclick = () => { doc.querySelector('#result').textContent = 'Opened'; };
  await runner.start({ goal: 'Open' });
  assert.deepEqual(stages, ['classification', 'component', 'action', 'component', 'component']);
  assert.equal(runner.state.steps, 1);
});

test('complex queue advances only after two confirmations and logs every stage', async () => {
  const goals = [], files = new Map();
  const { runner } = setup(async body => {
    if (body.model === TEXT_MODEL) return completion([task('Find X'), task('Open X')]);
    if (body.state.stage === 'classification') return complexity('complex');
    goals.push(body.state.goal);
    return decision('done');
  }, { logger: { async reset() {}, async write(name, value) { files.set(name, value); } } });
  await runner.start({ goal: 'Find and open X' });
  assert.deepEqual(goals.map(g => g.split('\n')[0]), ['Find X', 'Find X', 'Open X', 'Open X']);
  assert.equal(runner.state.plan.completed.length, 2);
  assert.equal(files.size, 12);
  assert.equal(runner.state.config.goal, 'Find and open X');
});

test('blocked replans remaining queue and preserves completed goals with bounded retries', async () => {
  let plans = 0;
  const inputs = [];
  const { runner } = setup(async body => {
    if (body.model === TEXT_MODEL) {
      inputs.push(JSON.parse(body.messages[1].content));
      plans++;
      return completion(plans === 1 ? [task('Find X'), task('Open X')] : [task('Alternative X')]);
    }
    if (body.state.stage === 'classification') return complexity('complex');
    return decision(body.state.goal.startsWith('Find X') ? 'done' : 'blocked');
  });
  await runner.start({ goal: 'Find and open X' });
  assert.equal(plans, 3);
  assert.deepEqual(inputs[1].completed, [task('Find X')]);
  assert.deepEqual(inputs[1].remaining, [task('Open X')]);
  assert.equal(runner.state.plan.replans, 2);
  assert.equal(runner.state.active, false);
});

test('resume retains queue position without classifying or planning again', async () => {
  const { runner, store } = setup(async body => {
    assert.equal(body.state.stage, 'component');
    assert.ok(body.state.goal.startsWith('Open X'));
    return decision('done');
  });
  await store.save({ config: { goal: 'Find and open X' }, active: true, startedAt: Date.now(), steps: 1, history: [], seen: [], successVotes: 0, requestId: 5, plan: { tasks: [task('Find X'), task('Open X')], index: 1, completed: [task('Find X')], replans: 0 } });
  await runner.resume();
  assert.equal(runner.state.plan.completed.length, 2);
  assert.equal(runner.state.requestId, 7);
});

test('Stop during planning never installs a late plan or executes actions', async () => {
  let entered, resolvePlan;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { runner, store } = setup(async body => {
    if (body.model !== TEXT_MODEL) return complexity('complex');
    entered();
    return new Promise(resolve => { resolvePlan = resolve; });
  });
  const run = runner.start({ goal: 'Complex' });
  await waiting;
  await runner.stop();
  resolvePlan(completion([task('Late')]));
  await run;
  assert.equal(runner.state.plan, undefined);
  assert.equal(await store.load(), null);
  assert.equal(runner.state.steps, 0);
});

test('rejects empty, excessive, malformed, refused and truncated plans', () => {
  for (const tasks of [[], Array.from({ length: 9 }, () => task('X')), [{ goal: 'X' }], [task(' ')]]) assert.throws(() => parsePlan(completion(tasks)));
  assert.throws(() => parsePlan({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  assert.throws(() => parsePlan({ choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: '{}' } }] }));
});

test('two queued goals execute real actions in order through the existing two stages', async () => {
  const calls = [];
  let opened = false, added = false;
  const { runner, doc } = setup(async body => {
    if (body.model === TEXT_MODEL) return completion([task('Open X'), task('Add X')]);
    if (body.state.stage === 'classification') return complexity('complex');
    const first = body.state.goal.startsWith('Open X');
    calls.push([first ? 'open' : 'add', body.state.stage]);
    if (body.state.stage === 'component') return decision((first ? opened : added) ? 'done' : 'g0');
    return decision('a0');
  });
  doc.querySelector('button').onclick = () => {
    if (!opened) { opened = true; doc.querySelector('button').textContent = 'Add'; }
    else { added = true; doc.querySelector('#result').textContent = 'Added'; }
  };
  await runner.start({ goal: 'Open X and add X' });
  assert.equal(added, true);
  assert.equal(runner.state.steps, 2);
  assert.equal(runner.state.plan.completed.length, 2);
  assert.deepEqual(calls.filter(([, stage]) => stage === 'action').map(([goal]) => goal), ['open', 'add']);
});

test('missing planner key stops before actions; final explicit success condition remains mandatory', async () => {
  const missing = setup(async () => complexity('complex'), { openaiApiKey: '' });
  await missing.runner.start({ goal: 'Complex' });
  assert.equal(missing.runner.state.steps, 0);
  assert.equal(missing.runner.state.plan, undefined);
  const explicit = setup(async body => body.model === TEXT_MODEL ? completion([task('First'), task('Last')]) : body.state.stage === 'classification' ? complexity('complex') : decision('done'));
  await explicit.runner.start({ goal: 'Complex', success: { type: 'text', value: 'Missing evidence' } });
  assert.equal(explicit.runner.state.plan.completed.length, 1);
  assert.equal(explicit.runner.state.plan.index, 1);
});
