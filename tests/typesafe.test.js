import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransport, requestBody, parseDecision, textRequest } from '../src/core.js';
import { gmTransport } from '../src/tampermonkey.js';

const snapshot = {
  url: 'https://example.org', title: 'Quiz', text: 'Question', headings: [],
  groups: [{ id: 'g0', text: 'Question', selected: [] }],
  actions: [{ id: 'a0', group: 'g0', kind: 'click', label: 'Submit' }],
};
const response = choice => ({
  model: 'jev-1.13.0',
  answers: {
    next: { type: 'choice', choice, confidence: 0.8, probabilities: { [choice]: 0.9, blocked: 0.1 } },
    achieved: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 300, output_tokens: 30 },
});

for (const adapter of ['fetch', 'GM']) {
  test(`${adapter} sends both decision stages to official TypeSafe API and parses answers`, async t => {
    let expectedBody;
    const signal = new AbortController().signal;
    const verify = (url, options, serialized) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer typesafe-test');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(expectedBody)));
      assert.equal(expectedBody.model, 'jev-1.13.0');
      assert.equal(expectedBody.questions.next.type, 'choice');
      assert.equal(expectedBody.questions.achieved.type, 'noul');
      return response(expectedBody.state.stage === 'component' ? 'g0' : 'a0');
    };
    let transport;
    if (adapter === 'fetch') {
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(options.signal, signal);
        return new Response(JSON.stringify(verify(url, options, options.body)), { status: 200 });
      });
      transport = fetchTransport;
    } else {
      transport = gmTransport(options => {
        const data = verify(options.url, options, options.data);
        queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(data) }));
        return { abort() {} };
      });
    }
    for (const component of [null, 'g0']) {
      expectedBody = requestBody('Complete quiz', snapshot, [], component);
      const data = await transport(expectedBody, { apiKey: 'typesafe-test', signal });
      const decision = parseDecision(data, component ? snapshot.actions : snapshot.groups);
      assert.equal(decision.choice, component ? 'a0' : 'g0');
      assert.equal(decision.confidence, 0.8);
      assert.equal(decision.achieved, 0.1);
    }
  });
}

test('fetch still sends text generation to OpenAI with its own key', async t => {
  const body = textRequest('Search for shoes', {}, { label: 'Search', maxLength: 100 });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer openai-test');
    assert.deepEqual(JSON.parse(options.body), body);
    return new Response('{}');
  });
  await fetchTransport(body, { apiKey: 'openai-test' });
});
