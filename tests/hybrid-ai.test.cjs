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

test('Gemini answers hand off intact to Qwen for English and Taglish follow-ups', async t => {
  const answer = 'Detailed explanation. '.repeat(65);
  const fetch = t.mock.method(globalThis, 'fetch', async url => url.startsWith('https:')
    ? Response.json({ choices: [{ message: { content: answer } }] })
    : Response.json({ message: { content: 'Short explanation.' } }));
  const first = await ask('Explain recursion', config('gemini'));
  const history = [{ role: 'user', content: 'Explain recursion' }, { role: 'assistant', content: first.message }];
  for (const prompt of ['Make it shorter', 'Paikliin mo yan', 'Give another example of that']) {
    await ask(prompt, config('gemini'), undefined, history);
    const [url, options] = fetch.mock.calls.at(-1).arguments;
    assert.match(url, /^http:\/\/127\.0\.0\.1/);
    const messages = JSON.parse(options.body).messages;
    assert.equal(messages.find(m => m.role === 'assistant').content, answer.trim());
    assert.match(messages[0].content, /Filipino, and Taglish/);
  }
  assert.equal(fetch.mock.calls.filter(call => call.arguments[0].startsWith('https:')).length, 1);
});

test('local-only instructions in recent user history and pet questions never reach cloud', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /^http:\/\/127\.0\.0\.1/);
    return Response.json({ message: { content: 'Local answer.' } });
  });
  await ask('Explain arrays', config('gemini'), undefined, [{ role: 'user', content: 'Use local only' }]);
  await ask('Are you hungry?', config('gemini'));
  await ask('Do not use Gemini. Explain arrays.', config('gemini'));
  assert.equal(fetch.mock.callCount(), 3);
});

test('multiple cloud tool proposals fall back and multiple local proposals cannot execute', async t => {
  const calls = [1, 2].map(n => ({ function: { name: 'create_file', arguments: { name: 'notes.txt', content: String(n) } } }));
  const runs = [];
  t.mock.method(globalThis, 'fetch', async url => url.startsWith('https:')
    ? Response.json({ choices: [{ message: { tool_calls: calls } }] })
    : Response.json({ message: { tool_calls: calls } }));
  const result = await ask('Create notes.txt with study notes', config('gemini'), run => runs.push(run));
  assert.equal(result.type, 'reply');
  assert.match(result.message, /No action was run/);
  assert.deepEqual(runs, [{ engine: 'qwen', fallback: 'gemini' }]);
});

test('truncated local file generation never produces a save intent', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ done_reason: 'length', message: {
    tool_calls: [{ function: { name: 'create_file', arguments: { name: 'notes.txt', content: 'Partial' } } }],
  } }));
  const result = await ask('Create notes.txt with study notes');
  assert.equal(result.type, 'reply');
  assert.match(result.message, /No action was run/);
});

test('interrupted streaming clears drafts and complete streaming preserves the answer', async t => {
  let done = false;
  t.mock.method(globalThis, 'fetch', async () => new Response([
    JSON.stringify({ message: { content: 'A partial explanation that is long enough to display as a draft.' } }),
    ...(done ? [JSON.stringify({ done: true, message: { content: '' } })] : []),
  ].join('\n')));
  const drafts = [];
  const run = () => interpret([{ role: 'user', content: 'Explain arrays' }], pet, 'Downloads', text => drafts.push(text));
  assert.match((await run()).message, /No action was run/);
  assert.equal(drafts.at(-1), '');
  done = true;
  assert.match((await run()).message, /^A partial explanation/);
});

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
