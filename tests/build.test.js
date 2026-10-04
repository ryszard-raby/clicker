import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

test('build loads .env, honors environment and runtime overrides, and works without a key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clickator-env-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  await cp(new URL('../build.mjs', import.meta.url), join(root, 'build.mjs'));
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.OPENAI_API_KEY;
  async function build(expected, variables = env, expectedOpenAI = '') {
    const output = execFileSync(process.execPath, ['build.mjs'], { cwd: root, env: variables, encoding: 'utf8' });
    if (expected) assert.ok(!output.includes(expected), 'Build must not log the key');
    if (expectedOpenAI) assert.ok(!output.includes(expectedOpenAI));
    const dom = new JSDOM('<p>Test</p>', { url: 'https://example.org', runScripts: 'outside-only' });
    dom.window.eval(await readFile(join(root, 'dist/clickator.js'), 'utf8'));
    const api = dom.window.Clickator;
    assert.equal(await api.create().getApiKey(), expected);
    assert.equal(await api.create().getOpenAIKey(), expectedOpenAI);
    assert.equal(await api.create({ openaiApiKey: 'override-openai' }).getOpenAIKey(), 'override-openai');
    assert.equal(await api.create({ apiKey: 'runtime-key' }).getApiKey(), 'runtime-key');
    assert.equal(await api.create({ getApiKey: () => 'provider-key' }).getApiKey(), 'provider-key');
    const runner = api.mount();
    assert.equal(await runner.getApiKey(), expected);
    dom.window.close();
  }
  await build('');
  // A legacy provider key must never be sent to TypeSafe.
  await writeFile(join(root, '.env'), 'DEFAPI_API_KEY=legacy-provider-key\n');
  await build('', { ...env, DEFAPI_API_KEY: 'legacy-environment-key' });
  // Quotes, backslashes, backticks and interpolation must remain literal data.
  const dummy = 'test-"quoted"-\\-`-${literal}-#';
  await writeFile(join(root, '.env'), `TYPESAFE_API_KEY='${dummy}'\nOTHER_SECRET=not-for-browser\n`);
  await build(dummy);
  assert.ok(!(await readFile(join(root, 'dist/clickator.js'), 'utf8')).includes('not-for-browser'));
  await build('environment-key', { ...env, TYPESAFE_API_KEY: 'environment-key' });
  await build('', { ...env, TYPESAFE_API_KEY: '' });
  await writeFile(join(root, '.env'), 'TYPESAFE_API_KEY=typesafe-test\nOPENAI_API_KEY=openai-test\n');
  await build('typesafe-test', env, 'openai-test');
  await build('typesafe-test', { ...env, OPENAI_API_KEY: 'openai-env' }, 'openai-env');
});
