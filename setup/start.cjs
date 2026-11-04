const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { delimiter, isAbsolute, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { config: { ollama_model: model } } = require('../package.json');

const root = resolve(__dirname, '..');
const ollamaHost = '127.0.0.1:11434';
const ollamaEnv = { ...process.env, OLLAMA_HOST: ollamaHost, OLLAMA_NO_CLOUD: '1' };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + ' stopped with ' + (signal ?? 'exit code ' + code) + '.'));
    });
  });
}

function npm(...args) {
  if (!process.env.npm_execpath) throw new Error('Run this through npm start.');
  return run(process.execPath, [process.env.npm_execpath, ...args]);
}

async function installDependencies() {
  const lock = readFileSync(join(root, 'package-lock.json'));
  const digest = createHash('sha256').update(lock).digest('hex');
  const modules = join(root, 'node_modules');
  const stamp = join(modules, '.pet-pocket-lock');
  const electronPath = join(modules, 'electron', 'path.txt');
  const electronReady = existsSync(electronPath) &&
    existsSync(join(modules, 'electron', 'dist', readFileSync(electronPath, 'utf8').trim()));
  if (electronReady && existsSync(join(modules, 'typescript', 'bin', 'tsc')) &&
      existsSync(stamp) && readFileSync(stamp, 'utf8') === digest) return;
  console.log('Pet Pocket | Installing locked dependencies…');
  await npm('ci');
  writeFileSync(stamp, digest);
}

function findOllama() {
  const folders = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'),
    ...((process.env.PATH ?? '').split(delimiter).map(entry => entry.trim().replace(/^"|"$/g, ''))),
  ];
  return folders.filter(folder => folder && isAbsolute(folder))
    .map(folder => join(folder, 'ollama.exe')).find(path => existsSync(path));
}

async function localModels() {
  try {
    const response = await fetch('http://' + ollamaHost + '/api/tags', {
      signal: AbortSignal.timeout(1800), redirect: 'error',
    });
    if (!response.ok) return null;
    const result = await response.json();
    return Array.isArray(result.models) ? result.models.map(entry => entry.name) : null;
  } catch {
    return null;
  }
}

async function setupAI() {
  let models = await localModels();
  if (!models?.includes(model)) {
    let executable = findOllama();
    if (!executable) {
      console.log('Pet Pocket | Installing Ollama for this Windows account…');
      await run('winget.exe', ['install', '--id', 'Ollama.Ollama', '--exact', '--source', 'winget',
        '--scope', 'user', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements']);
      executable = findOllama();
      if (!executable) throw new Error('Ollama was installed but its command was not found. Open a new terminal.');
      models = await localModels();
    }
    if (models === null) {
      console.log('Pet Pocket | Starting the local Ollama server…');
      const server = spawn(executable, ['serve'], {
        detached: true, windowsHide: true, stdio: 'ignore', env: ollamaEnv,
      });
      let launchError;
      server.once('error', error => { launchError = error; });
      server.unref();
      const deadline = Date.now() + 15_000;
      while (models === null && Date.now() < deadline && !launchError) {
        await delay(400);
        models = await localModels();
      }
      if (models === null) throw launchError ?? new Error('Ollama did not start on ' + ollamaHost + '.');
    }
    if (!models.includes(model)) {
      console.log('Pet Pocket | Downloading ' + model + ' for Ask Pet. The first download is about 2.5 GB.');
      await run(executable, ['pull', model], { env: ollamaEnv });
      if (!(await localModels())?.includes(model)) throw new Error('Ollama did not list ' + model + ' after the download.');
    }
  }
  console.log('Pet Pocket | Local AI ready (' + model + ').');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Pet Pocket requires Windows.');
  const args = process.argv.slice(2);
  const aiOnly = args.includes('--ai-only');
  if (!aiOnly) {
    await installDependencies();
    await npm('run', 'build');
  }
  if (!args.includes('--skip-ai')) {
    try {
      await setupAI();
    } catch (error) {
      console.error('Pet Pocket | Local AI setup failed. ' + error.message);
      console.error('Install Ollama from https://ollama.com/download/windows if needed, then run npm run setup:ai.');
      if (aiOnly) { process.exitCode = 1; return; }
    }
  }
  if (!aiOnly) await run(require('electron'), ['.']);
}

main().catch(error => {
  console.error('Pet Pocket | ' + error.message);
  process.exitCode = 1;
});
