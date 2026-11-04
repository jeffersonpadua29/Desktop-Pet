const { test } = require('node:test');
const assert = require('node:assert/strict');
const { interpret } = require('../dist/assistant');

const pet = { name: 'Anino', food: 80, energy: 80, bond: 10, asleep: false };
const ask = (content, spotify) =>
  interpret([{ role: 'user', content }], pet, 'Downloads', undefined, spotify);

test('Spotify searches accept follow-ups with and without a play request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Spotify search should route without Ollama');
  });
  assert.deepEqual(await ask('Search for Just the Two of Us on Spotify'), { type: 'spotify-search', query: 'Just the Two of Us' });
  assert.deepEqual(await ask('now search for Uncle Dags', {}), { type: 'spotify-search', query: 'Uncle Dags' });
  assert.deepEqual(await ask('then search for MATIKAS and play', {}), { type: 'spotify-search', query: 'MATIKAS', play: true });
  assert.deepEqual(await ask('Hi, open Spotify and search and play the song MATIKAS'), { type: 'spotify-search', query: 'MATIKAS', play: true });
  assert.deepEqual(await ask('Actually, play Never Gonna Give You Up on Spotify'), { type: 'spotify-search', query: 'Never Gonna Give You Up', play: true });
  assert.deepEqual(await ask('Now play it', { query: 'MATIKAS' }), {
    type: 'reply', message: 'Select the track in the Spotify results for “MATIKAS” to start playback.',
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Spotify context preserves explicit local file searches', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    message: { tool_calls: [{ function: { name: 'find_files', arguments: { name: 'report', extension: 'pdf', date: 'any' } } }] },
  }));
  for (const [command, spotify] of [
    ['now search for report.pdf', {}],
    ['search for a file named report', {}],
    ['search for report', undefined],
  ]) {
    assert.equal((await ask(command, spotify)).type, 'find');
  }
  assert.equal(fetch.mock.callCount(), 3);
});

test('Ollama receives prior messages with their conversation roles', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: { content: 'A brief follow-up.' } }));
  const turns = [
    { role: 'user', content: 'What is a circuit?' },
    { role: 'assistant', content: 'A path for electric current.' },
    { role: 'user', content: 'How does it work?' },
  ];
  await interpret(turns, pet, 'Downloads');
  const request = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.deepEqual(request.messages.slice(1), turns);
  assert.equal(request.tools, undefined);
});
