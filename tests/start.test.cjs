const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');
const { config: { ollama_model: model } } = require('../package.json');

const script = readFileSync(path.join(__dirname, '../setup/start.cjs'), 'utf8');

async function startup({ installed = false, server = false, models = [] } = {}) {
  const root = path.resolve(__dirname, '..');
  const local = path.join(root, 'test-local');
  const executable = path.join(local, 'Programs', 'Ollama', 'ollama.exe');
  const commands = [];
  const notices = [];
  const process = {
    platform: 'win32', argv: ['node', 'start.cjs'], execPath: 'node',
    env: { LOCALAPPDATA: local, npm_execpath: 'npm-cli.js' },
  };
  const fs = {
    existsSync: file => file === executable && installed,
    readFileSync: () => Buffer.from('test lockfile'),
    writeFileSync: () => {},
  };
  const spawn = (command, args, options) => {
    commands.push([path.basename(command), Array.from(args)]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      if (command === 'winget.exe') installed = true;
      if (args[0] === 'serve') {
        assert.equal(options.env.OLLAMA_HOST, '127.0.0.1:11434');
        server = true;
        return;
      }
      if (args[0] === 'pull') models.push(args[1]);
      child.emit('close', 0);
    });
    return child;
  };
  await vm.runInNewContext(script, {
    __dirname: path.join(root, 'setup'), process, AbortSignal,
    fetch: async () => ({
      ok: server, json: async () => ({ models: models.map(name => ({ name })) }),
    }),
    console: { log: message => notices.push(message), error: message => notices.push(message) },
    require: name => ({
      'node:child_process': { spawn }, 'node:fs': fs,
      'node:timers/promises': { setTimeout: async () => {} },
      '../package.json': { config: { ollama_model: model } }, electron: 'electron.exe',
    })[name] ?? require(name),
  });
  assert.equal(process.exitCode, undefined, notices.join('\n'));
  return commands;
}

test('first start installs dependencies, Ollama and the Qwen model before launching Electron', async () => {
  const commands = await startup();
  assert.deepEqual(commands.map(([command, args]) => [command, args[0]]), [
    ['node', 'npm-cli.js'], ['node', 'npm-cli.js'], ['winget.exe', 'install'],
    ['ollama.exe', 'serve'], ['ollama.exe', 'pull'], ['electron.exe', '.'],
  ]);
  assert.deepEqual(commands[0][1], ['npm-cli.js', 'ci']);
  assert.deepEqual(commands[1][1], ['npm-cli.js', 'run', 'build']);
  assert.deepEqual(commands[4][1], ['pull', model]);
});

test('startup reuses Qwen already listed by the local server', async () => {
  const commands = await startup({ installed: true, server: true, models: [model] });
  assert.deepEqual(commands.map(([command]) => command), ['node', 'node', 'electron.exe']);
});
