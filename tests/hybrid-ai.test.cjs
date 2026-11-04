const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { interpret, saveGeneratedFile } = require('../dist/assistant');
const { chatCloud, cloudModels } = require('../dist/cloud-ai');
const { projectEdit, selectProjectSource, applyProjectSource, proposeSource } = require('../dist/project-ai');

const pet = { name: 'Private pet name', food: 80, energy: 80, bond: 10, asleep: false };
const config = provider => ({ provider, model: cloudModels[provider], key: 'fixture-key' });
const ask = (text, cloud, onRun, previous = []) => interpret(
  [...previous, { role: 'user', content: text }], pet, 'Downloads', undefined, undefined, { cloud, onRun },
);

test('each provider returns a normalized tool call without sending credentials in the body', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    const args = { name: 'test.txt', content: 'Hello' };
    return url.includes('anthropic') ? Response.json({
      content: [{ type: 'tool_use', name: 'create_file', input: args }],
    }) : Response.json({
      choices: [{ message: { tool_calls: [{ function: { name: 'create_file', arguments: JSON.stringify(args) } }] } }],
    });
  });
  for (const provider of ['gemini', 'openai', 'anthropic']) {
    const response = await chatCloud(config(provider), 'system', 'prompt');
    assert.deepEqual(response.tool_calls[0].function, { name: 'create_file', arguments: { name: 'test.txt', content: 'Hello' } });
  }
  const requests = fetch.mock.calls.map(({ arguments: [url, options] }) => [new URL(url).hostname, options]);
  assert.deepEqual(requests.map(([host]) => host), ['generativelanguage.googleapis.com', 'api.openai.com', 'api.anthropic.com']);
  for (const [, request] of requests) assert.doesNotMatch(request.body, /fixture-key/);
  assert.equal(requests[2][1].headers['x-api-key'], 'fixture-key');
});

test('HTTP errors and invalid cloud output fall back to Qwen while local tasks bypass cloud', async t => {
  const runs = [];
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('openai.com')) return new Response('', { status: 401 });
    if (url.includes('googleapis.com')) return Response.json({ choices: [] });
    return Response.json({ message: { content: 'Local answer.' } });
  });
  for (const provider of ['openai', 'gemini']) {
    assert.deepEqual(await ask('Explain arrays', config(provider), run => runs.push(run), [
      { role: 'user', content: 'Prior local message' },
    ]), { type: 'reply', message: 'Local answer.' });
  }
  assert.deepEqual(runs, [{ engine: 'qwen', fallback: 'openai' }, { engine: 'qwen', fallback: 'gemini' }]);
  assert.equal(fetch.mock.callCount(), 4);
  const [, cloudRequest] = fetch.mock.calls[0].arguments;
  assert.doesNotMatch(cloudRequest.body, /Prior local message|Private pet name/);
  assert.equal((await ask('Open Spotify', config('openai'))).type, 'launch');
  assert.equal(fetch.mock.callCount(), 4);
});

test('an Excel request creates a workbook with typed data from validated cloud tool output', async t => {
  const rows = [['Item', 'Cost'], ['Coffee', 4]];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { tool_calls: [{ function: {
    name: 'create_file', arguments: JSON.stringify({ name: 'wrong.csv', content: JSON.stringify(rows) }),
  } }] } }] }));
  const intent = await ask('Create expenses.xlsx with an item and cost table', config('openai'));
  assert.equal(intent.type, 'create-file');
  const folder = await mkdtemp(join(tmpdir(), 'pet-pocket-hybrid-'));
  const target = join(folder, 'expenses.xlsx');
  t.after(async () => { await unlink(target).catch(() => {}); await rmdir(folder); });
  await saveGeneratedFile(folder, intent.file);
  const { readSheet } = await import('read-excel-file/node');
  assert.deepEqual(await readSheet(target, 'Sheet1'), rows);
});

test('project edits fall back locally, stage without writing and reject stale source', async t => {
  const folder = await mkdtemp(join(__dirname, '..', '.pet-pocket-project-'));
  const target = join(folder, 'index.js');
  t.after(async () => { await unlink(target).catch(() => {}); await rmdir(folder); });
  await writeFile(target, 'let value = 1;');
  const edit = projectEdit('Fix index.js and run tests and create an Excel test report');
  assert.equal(edit.test, true);
  assert.equal(edit.report, true);
  await assert.rejects(selectProjectSource(folder, '../index.js'), /relative/);
  const source = await selectProjectSource(folder, edit.file);
  const revised = 'let value = 2;';
  let cloudReturnsOriginal = false;
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    const call = content => ({ function: { name: 'propose_source', arguments: { content } } });
    if (url.startsWith('https:')) return cloudReturnsOriginal
      ? Response.json({ choices: [{ message: { tool_calls: [call(source.original)] } }] })
      : new Response('', { status: 429 });
    return Response.json({ message: { tool_calls: [call(revised)] } });
  });
  assert.deepEqual(await proposeSource(edit, source, 'fixture-qwen', config('gemini')),
    { content: revised, engine: 'qwen', fallback: 'gemini' });
  cloudReturnsOriginal = true;
  assert.deepEqual(await proposeSource(edit, source, 'fixture-qwen', config('gemini')),
    { content: revised, engine: 'qwen', fallback: 'gemini' });
  assert.equal(fetch.mock.callCount(), 4);
  assert.equal(await readFile(target, 'utf8'), source.original);
  await applyProjectSource(source, revised);
  assert.equal(await readFile(target, 'utf8'), revised);
  await assert.rejects(applyProjectSource(source, 'let value = 3;'), /changed after/);
  assert.equal(await readFile(target, 'utf8'), revised);
});
