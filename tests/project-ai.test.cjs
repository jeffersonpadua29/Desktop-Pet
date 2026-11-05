const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, unlink, rmdir } = require('node:fs/promises');
const { join } = require('node:path');
const { projectEdit, selectProjectSource, proposeSource, applyProjectSource, maxSourceBytes } = require('../dist/project-ai');

const edit = { file: 'index.js', request: 'Change value to 2', test: false, report: false };
const source = (original, file = 'index.js') => ({ root: 'fixture', path: join('fixture', file), original });
const toolCall = (name, args) => ({ tool_calls: [{ function: { name, arguments: args } }] });
const patch = replacements => toolCall('propose_patch', { replacements });

test('language conversions and corrections choose the target extension without breaking creation', () => {
  for (const command of ['Convert it to C', 'Rewrite that file in C', 'Use C instead of Python', 'Make it C instead of Python',
    'It should be C instead of Python', 'C instead of Python', 'Instead of Python use C', 'Change to .c']) {
    assert.equal(projectEdit(command, true)?.outputExtension, '.c', command);
  }
  assert.equal(projectEdit('Convert sort.py to main.c').file, 'sort.py');
  assert.equal(projectEdit('Convert sort.py to main.c').outputName, 'main.c');
  assert.equal(projectEdit('Convert it to C++', true).outputExtension, '.cpp');
  assert.equal(projectEdit('Rewrite it in C#', true).outputExtension, '.cs');
  assert.equal(projectEdit('Make notes.txt'), undefined);
  assert.equal(projectEdit('Fix app.py to print the letter C').outputExtension, undefined);
});

test('conversion prompts request real target-language code and reject unchanged source', async t => {
  const python = 'print("Hello")\n';
  const c = '#include <stdio.h>\nint main(void) { puts("Hello"); return 0; }\n';
  let content = python;
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: toolCall('propose_source', { content }) }));
  const conversion = projectEdit('Convert hello.py to C');
  await assert.rejects(proposeSource(conversion, source(python, 'hello.py'), 'qwen-fixture'), /unchanged code/);
  content = c;
  assert.equal((await proposeSource(conversion, source(python, 'hello.py'), 'qwen-fixture')).content, c);
  const body = JSON.parse(fetch.mock.calls.at(-1).arguments[1].body);
  assert.equal(JSON.parse(body.messages.at(-1).content).outputFilename, 'hello.c');
  assert.match(body.messages[0].content, /Convert the implementation/);
  assert.doesNotMatch(body.messages[0].content, /Preserve the language/);
});

test('applying a conversion creates the requested filename without overwriting either file', async t => {
  const folder = await mkdtemp(join(__dirname, '..', '.pet-pocket-convert-'));
  const original = join(folder, 'hello.py'), converted = join(folder, 'hello.c');
  t.after(async () => { await unlink(original).catch(() => {}); await unlink(converted).catch(() => {}); await rmdir(folder); });
  await writeFile(original, 'print("Hello")\n');
  const selected = await selectProjectSource(folder, 'hello.py');
  await applyProjectSource(selected, 'int main(void) { return 0; }\n', 'hello.c');
  assert.equal(await readFile(original, 'utf8'), 'print("Hello")\n');
  assert.equal(await readFile(converted, 'utf8'), 'int main(void) { return 0; }\n');
  await assert.rejects(applyProjectSource(selected, 'overwrite', 'hello.c'), { code: 'EEXIST' });
  assert.equal(await readFile(converted, 'utf8'), 'int main(void) { return 0; }\n');
  await assert.rejects(applyProjectSource(selected, 'escape', '../escape.c'), /filename/);
  await unlink(converted);
  await writeFile(original, 'changed after preview');
  await assert.rejects(applyProjectSource(selected, 'stale conversion', 'hello.c'), /changed after/);
  await assert.rejects(readFile(converted), { code: 'ENOENT' });
});

test('small coding patches preserve untouched content and Windows line endings', async t => {
  const original = '// preserve this\r\nconst value = 1;\r\nconsole.log(value);\r\n';
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: patch([
    { oldText: 'const value = 1;\n', newText: 'const value = 2;\n' },
    { oldText: 'console.log(value);', newText: 'console.log(value * 2);' },
  ]) }));
  const result = await proposeSource(edit, source(original), 'qwen-fixture');
  assert.equal(result.content, '// preserve this\r\nconst value = 2;\r\nconsole.log(value * 2);\r\n');
  const request = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.deepEqual(request.tools.map(tool => tool.function.name), ['propose_source', 'propose_patch']);
  assert.match(request.messages[0].content, /Prefer propose_patch/);
});

test('patches reject ambiguous, missing, empty, no-op and excessive replacements', async t => {
  let replacements;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: patch(replacements) }));
  const cases = [
    [{ oldText: '1', newText: '2' }],
    [{ oldText: 'missing', newText: '2' }],
    [{ oldText: '', newText: '2' }],
    [{ oldText: 'let x = 1;', newText: 'let x = 1;' }],
    [],
    Array(13).fill({ oldText: 'let x = 1;', newText: 'let x = 2;' }),
  ];
  for (replacements of cases) await assert.rejects(proposeSource(edit, source('let x = 1;\nlet y = 1;'), 'qwen-fixture'));
});

test('invalid cloud patch falls back locally and final JSON must parse', async t => {
  const runs = [];
  t.mock.method(globalThis, 'fetch', async url => {
    runs.push(url);
    const message = url.startsWith('https:')
      ? patch([{ oldText: 'absent', newText: '2' }])
      : patch([{ oldText: '1', newText: '2' }]);
    return url.startsWith('https:') ? Response.json({ choices: [{ message }] }) : Response.json({ message });
  });
  const result = await proposeSource(edit, source('{"value":1}', 'data.json'), 'qwen-fixture', { provider: 'gemini', key: 'fixture', model: 'fixture' });
  assert.deepEqual(result, { content: '{"value":2}', engine: 'qwen', fallback: 'gemini' });
  assert.equal(runs.length, 2);
});

test('patch output rejects invalid JSON, multiple tools and truncated local generation', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  response = { message: patch([{ oldText: '1', newText: 'invalid' }]) };
  await assert.rejects(proposeSource(edit, source('{"value":1}', 'data.json'), 'qwen-fixture'));
  const call = patch([{ oldText: '1', newText: '2' }]).tool_calls[0];
  response = { message: { tool_calls: [call, call] } };
  await assert.rejects(proposeSource(edit, source('const value = 1;'), 'qwen-fixture'), /exactly one/);
  response = { done_reason: 'length', message: { tool_calls: [call] } };
  await assert.rejects(proposeSource(edit, source('const value = 1;'), 'qwen-fixture'), /generation limit/);
});

test('source files above 8 KB can be read and staged while stale and oversized files are rejected', async t => {
  const folder = await mkdtemp(join(__dirname, '..', '.pet-pocket-source-'));
  const path = join(folder, 'index.js');
  t.after(async () => { await unlink(path).catch(() => {}); await rmdir(folder); });
  const original = '// keep\n'.repeat(1500) + 'let value = 1;\n';
  await writeFile(path, original);
  const selected = await selectProjectSource(folder, 'index.js');
  assert.equal(selected.original, original);
  const revised = original.replace('value = 1', 'value = 2');
  await applyProjectSource(selected, revised);
  assert.equal(await readFile(path, 'utf8'), revised);
  await assert.rejects(applyProjectSource(selected, revised), /changed after/);
  await writeFile(path, 'x'.repeat(maxSourceBytes + 1));
  await assert.rejects(selectProjectSource(folder, 'index.js'), /32 KB/);
});
