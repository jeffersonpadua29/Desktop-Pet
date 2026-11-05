const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { interpret, saveGeneratedFile, renameRequest } = require('../dist/assistant');

const pet = { name: 'Anino', food: 80, energy: 80, bond: 10, asleep: false };
const ask = (content, previous = []) =>
  interpret([...previous, { role: 'user', content }], pet, 'Downloads');
const toolReply = (name, content) => Response.json({
  message: { tool_calls: [{ function: { name: 'create_file', arguments: { name, content } } }] },
});

test('extension and filename corrections resolve to explicit rename destinations', () => {
  for (const request of ['Change the extension to c', 'Change its extension to .c', 'Rename it to .c', 'Change it to .c']) {
    assert.equal(renameRequest(request)?.newName, '.c', request);
    assert.equal(renameRequest(request)?.invalidSource, false, request);
  }
  assert.equal(renameRequest('Change the filename to sort.c').newName, 'sort.c');
  assert.equal(renameRequest('Change script.py to script.c').source.name, 'script.py');
  assert.equal(renameRequest('Change the filename of script.py to ready.c').newName, 'ready.c');
  assert.equal(renameRequest('Change the extension of sort.py in Downloads to c').source.folder, 'downloads');
  assert.equal(renameRequest('Convert it to C'), undefined);
});

test('saving a previous answer as text retains it exactly without another model call', async t => {
  const answer = 'Long grounded answer.\n'.repeat(800);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Saving existing text does not need inference.'));
  const result = await ask('Save the previous answer as copy.txt', [{ role: 'assistant', content: answer }]);
  assert.deepEqual(result, { type: 'create-file', file: { name: 'copy.txt', content: answer } });
  assert.match((await ask('Save the previous answer as copy.txt')).message, /Which answer/);
  assert.match((await ask('Save the previous answer as copy.txt', [{ role: 'assistant', content: 'x'.repeat(40_000) }])).message, /too large/);
  assert.match((await ask('Save that as copy.csv', [{ role: 'assistant', content: answer }])).message, /too large for a complete model conversion/);
});

test('creation uses the file tool and writes the returned content without overwriting', async t => {
  const content = 'item,cost\ncoffee,4\n';
  const fetch = t.mock.method(globalThis, 'fetch', async () => toolReply('expenses.csv', content));
  const intent = await ask('Create a CSV for my weekly expenses');
  assert.deepEqual(intent, { type: 'create-file', file: { name: 'expenses.csv', content } });
  const request = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.deepEqual(request.tools.map(tool => tool.function.name), ['create_file']);
  const documents = await mkdtemp(join(tmpdir(), 'pet-pocket-files-'));
  const folder = join(documents, 'Pet Pocket');
  const path = join(folder, 'expenses.csv');
  t.after(async () => {
    await unlink(path).catch(() => {});
    await rmdir(folder).catch(() => {});
    await rmdir(documents);
  });
  const file = await saveGeneratedFile(folder, intent.file);
  assert.equal(file.path, path);
  assert.equal(await readFile(path, 'utf8'), content);
  await assert.rejects(saveGeneratedFile(folder, { ...intent.file, content: 'replacement' }), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), content);
});

test('capability and unsupported-format questions do not write files', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => toolReply('output.txt', 'text'));
  const question = await ask('Can you generate file?');
  assert.equal(question.type, 'reply');
  assert.match(question.message, /What should the file contain/);
  assert.equal((await ask('Save the notes as a PDF')).type, 'reply');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await ask('How can I generate a file?')).type, 'reply');
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).tools, undefined);
});

test('model output cannot specify a path, a device name, or invalid JSON', async t => {
  let name;
  t.mock.method(globalThis, 'fetch', async () => toolReply(name, 'plain text'));
  for (name of ['../outside.txt', 'folder\\inside.txt', 'con.txt', 'invalid.json', 'bad.exe']) {
    assert.equal((await ask('Create a file with this text')).type, 'reply');
  }
});

test('a C filename routes to file creation even without the word file', async t => {
  const content = 'void sort(int *a, int n) {\n  for (int end = n - 1; end > 0; --end)\n    for (int i = 0; i < end; ++i)\n      if (a[i] > a[i+1]) { int t = a[i]; a[i] = a[i+1]; a[i+1] = t; }\n}\n';
  const fetch = t.mock.method(globalThis, 'fetch', async () => toolReply('sort.c', content));
  const request = 'In my Documents folder, generate sort.c with bubble sort logic and no comments.';
  assert.deepEqual(await ask(request), { type: 'create-file', file: { name: 'sort.c', content } });
  const options = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.equal(options.tools[0].function.name, 'create_file');
  assert.match(options.messages[0].content, /omit code comments/);
});

test('creating a named empty file in Downloads does not require Ollama', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Blank file creation should not call Ollama');
  });
  assert.deepEqual(await ask('can you create a indexsort.c in my download folder'), {
    type: 'create-file', file: { name: 'indexsort.c', content: '' }, destination: 'downloads',
  });
  assert.equal((await ask('create ../../indexsort.c in Downloads')).type, 'reply');
  assert.equal(fetch.mock.callCount(), 0);
});

test('requested source contents still go to Qwen and retain the Downloads destination', async t => {
  const content = 'int index_sort(void) { return 0; }\n';
  const fetch = t.mock.method(globalThis, 'fetch', async () => toolReply('Downloads\\indexsort.c', content));
  const intent = await ask('Okay, now can you create indexsort.c in Downloads with a C function that sorts an array of indices by their values, then open it in VS Code?');
  assert.deepEqual(intent, { type: 'create-file', file: { name: 'indexsort.c', content }, destination: 'downloads', openInVSCode: true });
  assert.equal(fetch.mock.callCount(), 1);
  const request = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.doesNotMatch(request.messages.at(-1).content, /Downloads|VS Code/);
  assert.match(request.messages.at(-1).content, /sorts an array of indices by their values/);
});
