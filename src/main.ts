import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canOpenAssistantFile, findFiles, interpret, model, namedFileReference, renameRequest, saveGeneratedFile, type FileMatch, type Intent, type NamedFile, type SpotifyAction, type SpotifyContext, type Turn } from './assistant';
import { isWindowsFilename, renameLocalFile } from './file-rename';
import { chatCloud, cloudModels, isCloudModel, isCloudProvider, type AiRun, type AiSettingsView, type CloudConfig } from './cloud-ai';
import { applyProjectSource, isEditableFile, proposeSource, selectProjectSource, type FileScope, type ProjectEdit, type ProjectSource } from './project-ai';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { act, advance, fresh, isSpecies, companionDetails, customizePet, type Pet, type Species } from './pet';
import { defaultPreferences, normalizePreferences, isQuietTime } from './settings';
import { detectLocation, searchLocations, normalizeLocation, fetchWeather, type WeatherLocation, type WeatherState } from './weather';
import { routineAt, restoreRoutines, validateRoutines, type Routine, type RoutineState } from './routines';
import { restoreTodos, changeTodo, pendingReminders, reminderMessage, type Todo } from './todos';

app.setName('Anino');
const root = join(__dirname, '..');
let win: BrowserWindow;
let tray: Tray;
let rendererIsReady = false;
let home = {
  active: null as Species | null,
  pets: {} as Partial<Record<Species, Pet>>,
  position: null as { x: number; y: number } | null,
  quiet: false,
  notificationSetupOffered: false,
  preferences: { ...defaultPreferences },
  weatherLocation: null as WeatherLocation | null,
  weatherLastAlert: { key: '', time: 0 },
  routines: [] as Routine[],
  routineRuns: {} as Record<string, string>,
  todos: [] as Todo[],
};
let routineState: RoutineState = { active: null, occurrence: '', ends: 0 };

function quietNow() {
  return isQuietTime(home.preferences) || routineAt(home.routines).active?.activity === 'quiet';
}

function syncRoutines(now: number) {
  routineState = routineAt(home.routines, new Date(now));
  let changed = false;
  for (const pet of Object.values(home.pets)) {
    if (!pet?.routineSleep || (routineState.active?.activity === 'sleep' && pet.routineSleep.occurrence === routineState.occurrence)) continue;
    const key = pet.routineSleep.occurrence.split('/')[0] + ':' + pet.kind;
    if (home.routineRuns[key] === pet.routineSleep.occurrence) delete home.routineRuns[key];
    if (pet.nap === pet.routineSleep.until) {
      const wakeUntil = pet.wakeUntil;
      act(pet, 'wake', now);
      pet.wakeUntil = wakeUntil;
    }
    pet.routineSleep = null;
    changed = true;
  }
  const active = routineState.active;
  const pet = currentPet();
  if (active && active.activity !== 'roam') stopRoam(false);
  if (active && pet && !toyHome && !dragOffset && (active.activity === 'sleep' || active.activity === 'play')) {
    const key = active.id + ':' + pet.kind;
    if (home.routineRuns[key] !== routineState.occurrence) {
      home.routineRuns[key] = routineState.occurrence;
      changed = true;
      if (active.activity === 'play') {
        const reaction = act(pet, 'throw', now);
        if (win) win.webContents.send('care-feedback', reaction);
      } else if ((pet.wakeUntil ?? 0) <= now) {
        act(pet, 'sleep', now);
        pet.nap = routineState.ends;
        pet.routineSleep = { occurrence: routineState.occurrence, started: now, until: routineState.ends };
      }
    }
  }
  if (changed) save();
}
let weather: WeatherState = { location: null, report: null, error: '', loading: false };
let weatherRequest: Promise<void> | undefined;
let nextWeatherCheck = 0;
let lastWeatherAttempt = 0;

function sendPetAlert(source: string, message: string, count = 1, kind: 'desktop' | 'weather' | 'reminder' = 'desktop') {
  const prefs = home.preferences;
  const enabled = { desktop: prefs.desktopAlerts, weather: prefs.weatherAlerts, reminder: prefs.todoReminders }[kind];
  if (!currentPet() || !enabled) return false;
  win.webContents.send('pet-alert', {
    source, message: prefs.alertPreviews ? message : '', count,
    silent: home.quiet || quietNow() || !win.isVisible() || !prefs.alertPopups, kind,
  });
  return true;
}

async function updateWeather(force = false) {
  if (weatherRequest) return weatherRequest;
  if (!home.weatherLocation || (!force && (!home.preferences.weatherAlerts || Date.now() < nextWeatherCheck))) return;
  if (force && Date.now() - lastWeatherAttempt < 60000) return;
  const location = home.weatherLocation;
  lastWeatherAttempt = Date.now();
  nextWeatherCheck = Date.now() + 30 * 60000;
  weather.loading = true;
  weatherRequest = (async () => {
    try {
      const report = await fetchWeather(location);
      if (home.weatherLocation !== location) return;
      weather = { location, report, error: '', loading: true };
      const key = location.latitude + ',' + location.longitude + ':' + report.hazard;
      if (report.hazard && (home.weatherLastAlert.key !== key || Date.now() - home.weatherLastAlert.time >= 6 * 3600000) &&
          sendPetAlert('Weather', location.name + '. ' + report.advisory, 1, 'weather')) {
        home.weatherLastAlert = { key, time: Date.now() };
        save();
      }
    } catch {
      if (home.weatherLocation === location) weather.error = 'Weather unavailable. Check your connection or try again later.';
      nextWeatherCheck = Date.now() + 5 * 60000;
    } finally {
      weather.loading = false;
      weatherRequest = undefined;
    }
  })();
  return weatherRequest;
}
function currentPet() {
  return home.active ? home.pets[home.active] ?? null : null;
}
function updatePets() {
  const now = Date.now();
  for (const pet of Object.values(home.pets)) if (pet) advance(pet, now);
  syncRoutines(now);
}
function status() {
  updatePets();
  const names: Partial<Record<Species, string>> = {};
  for (const pet of Object.values(home.pets)) if (pet) names[pet.kind] = pet.name;
  const pet = currentPet();
  return { pet, playing, names, preferences: home.preferences, quietHoursActive: quietNow(), weather,
    routines: home.routines, routine: routineState, companion: pet ? companionDetails(pet) : null, todos: home.todos };
}

function checkTodoReminders() {
  if (!win || !rendererIsReady || !currentPet() || !home.preferences.todoReminders || home.quiet || quietNow() || !win.isVisible()) return;
  const pending = pendingReminders(home.todos, Date.now());
  if (!pending.length) return;
  const previous = home.todos;
  const due = new Set(pending.filter(value => value.due).map(value => value.item.id));
  const ids = new Set(pending.map(value => value.item.id));
  home.todos = home.todos.map(item => ids.has(item.id) ? { ...item, reminded: true, dueNotified: item.dueNotified || due.has(item.id) } : item);
  try { save(); } catch (error) { home.todos = previous; console.error('Could not save task reminders:', error); return; }
  for (const dueNow of [true, false]) {
    const items = pending.filter(value => value.due === dueNow).map(value => value.item);
    if (items.length) sendPetAlert('To-do', reminderMessage(items, dueNow), items.length, 'reminder');
  }
}
let alertFile: string | undefined;
let nextAlertLookup = 0;
const startedAt = Date.now();
let lastAlert = '';

const notificationSetup = join(root, 'setup', 'Install-Notifications.ps1');
const notificationBundle = join(root, 'setup', 'PetPocket-Notifications-x64.zip');
const notificationMetadata = join(root, 'setup', 'notification-bundle.json');
function canSetUpNotifications() {
  return process.arch === 'x64' && [notificationSetup, notificationBundle, notificationMetadata].every(path => existsSync(path));
}

function launchNotificationSetup() {
  if (!canSetUpNotifications()) return false;
  const process = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File', notificationSetup], {
    windowsHide: true, detached: true, stdio: 'ignore',
  });
  process.on('error', () => dialog.showErrorBox('Pet Pocket Notifications', 'Could not start notification setup. Run npm run setup:notifications from the project folder.'));
  process.unref();
  return true;
}

async function offerNotificationSetup() {
  if (home.notificationSetupOffered || home.quiet || !canSetUpNotifications()) return;
  home.notificationSetupOffered = true;
  save();
  try {
    const packages = join(app.getPath('appData'), '..', 'Local', 'Packages');
    if (readdirSync(packages).some(name => name.startsWith('PetPocket.NotificationListener_'))) return;
  } catch { /* The companion may not have been installed yet. */ }
  const choice = await dialog.showMessageBox({
    type: 'question',
    title: 'Pet Pocket Notifications',
    message: 'Set up live alerts?',
    detail: 'Setup will show the Pet Pocket development certificate and ask before trusting it. You can also do this later from the Desk tab.',
    buttons: ['Set up live alerts', 'Later'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response === 0) launchNotificationSetup();
}

function pollWindowsAlerts() {
  const now = Date.now();
  if (!alertFile && now >= nextAlertLookup) {
    nextAlertLookup = now + 10000;
    try {
      const packages = join(app.getPath('appData'), '..', 'Local', 'Packages');
      const folder = readdirSync(packages).find(name => name.startsWith('PetPocket.NotificationListener_'));
      if (folder) alertFile = join(packages, folder, 'LocalState', 'pet-alert.json');
    } catch { return; }
  }
  if (!alertFile) return;
  try {
    const data = JSON.parse(readFileSync(alertFile, 'utf8'));
    if (typeof data.id !== 'string' || typeof data.source !== 'string' ||
        typeof data.created !== 'number' || !Number.isFinite(data.created) || data.id === lastAlert) return;
    lastAlert = data.id;
    if (data.created < startedAt || data.created < now - 15000) return;
    sendPetAlert(data.source.slice(0, 80), typeof data.message === 'string' ? data.message.slice(0, 220) : '',
      typeof data.count === 'number' && Number.isFinite(data.count) ? Math.max(1, Math.min(3, Math.floor(data.count))) : 1);
  } catch { /* The companion may be offline or replacing its feed. */ }
}

let savePath: string;
let ignoreMouse = true;
let playing = false;
let roamTimer: ReturnType<typeof setInterval> | undefined;
let roamOrigin: Electron.Point | undefined;
let dragOffset: Electron.Point | undefined;

function stopRoam(restore = true) {
  if (roamTimer) clearInterval(roamTimer);
  roamTimer = undefined;
  const origin = roamOrigin;
  roamOrigin = undefined;
  if (restore && origin) win.setPosition(origin.x, origin.y);
}

function startRoam() {
  const pet = currentPet();
  const routine = routineAt(home.routines).active;
  if (toyHome || dragOffset || roamTimer || home.quiet || home.preferences.locked ||
      (home.preferences.roamFrequency === 'off' && routine?.activity !== 'roam') || (routine && routine.activity !== 'roam') ||
      quietNow() || !win.isVisible() || !ignoreMouse || !pet || pet.nap) return null;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const floating = pet.kind === 'ghost' || pet.kind === 'cloud';
  const range = floating ? 310 : 145;
  const clampPosition = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
  const offset = (Math.random() < .5 ? -1 : 1) * (range * (.45 + Math.random() * .55));
  const left = clampPosition(bounds.x + offset, area.x, area.x + area.width - bounds.width);
  const right = clampPosition(bounds.x - offset, area.x, area.x + area.width - bounds.width);
  const x = Math.round(Math.abs(left - bounds.x) >= 50 ? left : right);
  const y = floating
    ? Math.round(clampPosition(bounds.y + (Math.random() - .5) * 210, area.y, area.y + area.height - bounds.height))
    : bounds.y;
  const distance = Math.hypot(x - bounds.x, y - bounds.y);
  if (distance < 20) return null;
  const duration = Math.round(1150 + distance * (floating ? 5 : 6));
  const start = Date.now();
  roamOrigin = { x: bounds.x, y: bounds.y };
  roamTimer = setInterval(() => {
    if (quietNow()) { stopRoam(); return; }
    const progress = Math.min(1, (Date.now() - start) / duration);
    const ease = (1 - Math.cos(progress * 2 * Math.PI)) / 2;
    win.setPosition(Math.round(bounds.x + (x - bounds.x) * ease), Math.round(bounds.y + (y - bounds.y) * ease));
    if (progress === 1) stopRoam();
  }, 24);
  return { duration, facing: x >= bounds.x ? 'right' : 'left' };
}

let toyHome: Electron.Rectangle | undefined;

function closeToyStage() {
  if (!toyHome) return;
  if (win.isMaximized()) win.unmaximize();
  win.setBounds(toyHome);
  win.setResizable(false);
  toyHome = undefined;
}

async function launchVSCode(file?: string) {
  if (file) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return 'This file is no longer available.';
    const url = pathToFileURL(file);
    const path = url.host ? '//' + url.host + url.pathname : url.pathname;
    try {
      await shell.openExternal('vscode://file' + path);
      return '';
    } catch {
      return 'Windows couldn’t send this file to VS Code. Check that the desktop version of VS Code is installed.';
    }
  }
  const standardFolders = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ];
  const executables = standardFolders
    .filter((folder): folder is string => Boolean(folder))
    .map(folder => join(folder, 'Microsoft VS Code', 'Code.exe'));
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const folder = entry.trim().replace(/^"|"$/g, '');
    if (!isAbsolute(folder)) continue;
    executables.push(join(folder, 'Code.exe'));
    if (existsSync(join(folder, 'code.cmd'))) executables.push(join(folder, '..', 'Code.exe'));
  }
  const executable = executables.find(path => statSync(path, { throwIfNoEntry: false })?.isFile());
  if (!executable) return 'I couldn’t find VS Code. Check that it’s installed or available on PATH.';
  return new Promise<string>(resolve => {
    const editor = spawn(executable, [], { detached: true, stdio: 'ignore' });
    editor.once('error', () => resolve('Windows couldn’t launch VS Code.'));
    editor.once('spawn', () => {
      editor.unref();
      resolve('');
    });
  });
}

async function command(input: string) {
  const value = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const target = value.replace(/^(open|buksan) /, '');
  try {
    switch (target) {
      case 'arduino':
      case 'arduino ide': {
        const arduino = [
          process.env.ProgramFiles,
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
        ].filter((directory): directory is string => Boolean(directory))
          .map(directory => join(directory, 'Arduino IDE', 'Arduino IDE.exe'))
          .find(path => existsSync(path));
        if (!arduino) return { message: 'I couldn’t find Arduino IDE in its standard Windows install locations.' };
        if (await shell.openPath(arduino)) return { message: 'Windows could not launch Arduino IDE.' };
        return { message: 'Sent the launch request to Arduino IDE.' };
      }
      case 'spotify':
        await shell.openExternal('spotify:');
        return { message: 'Opening Spotify.', mood: 'headphones' };
      case 'downloads': {
        const error = await shell.openPath(app.getPath('downloads'));
        if (error) throw new Error(error);
        return { message: 'Downloads opened.' };
      }
      case 'calculator':
        await shell.openExternal('calculator:');
        return { message: 'Calculator opened.' };
      case 'vscode':
      case 'vs code':
      case 'visual studio code':
        return { message: await launchVSCode() || 'Opening VS Code.' };
      default:
        return { message: 'Available shortcuts are Spotify, Arduino IDE, VS Code, Downloads, and Calculator.' };
    }
  } catch {
    return { message: 'Windows could not open ' + target + '.' };
  }
}

async function closeSpotify() {
  return new Promise<{ message: string }>(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'spotify-window.ps1')],
      { windowsHide: true, timeout: 12000 }, (error, stdout) => {
        if (error) { resolve({ message: 'Windows could not close Spotify.' }); return; }
        switch (stdout.trim()) {
          case 'closed': resolve({ message: 'The Spotify window is closed. Spotify may still run in the tray.' }); break;
          case 'not-open': resolve({ message: 'I couldn’t find an open Spotify window.' }); break;
          case 'still-open': resolve({ message: 'I asked Spotify to close, but its window is still open.' }); break;
          default: resolve({ message: 'Windows could not close Spotify.' });
        }
      });
  });
}

async function controlSpotify(action: SpotifyAction | 'verify', query?: string) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'media.ps1'), '-Action', action];
  if (query) args.push('-EncodedQuery', Buffer.from(query, 'utf8').toString('base64'));
  return new Promise<string>(resolve => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 14_000 }, (error, stdout) => {
      resolve(error ? 'unconfirmed' : stdout.trim());
    });
  });
}

async function selectSpotifyResult(query: string): Promise<{ status: string; title?: string; artist?: string }> {
  const selected = await new Promise<string>(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'spotify-search-play.ps1'), '-EncodedQuery', Buffer.from(query, 'utf8').toString('base64')],
    { windowsHide: true, timeout: 14_000 }, (error, stdout) => resolve(error ? 'no-match' : stdout.trim()));
  });
  if (selected === 'no-match' || selected === 'ambiguous') return { status: selected };
  try {
    const data = JSON.parse(selected) as { title?: unknown; artist?: unknown };
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 400) return { status: 'unconfirmed' };
    const title = data.title.trim();
    const artist = typeof data.artist === 'string' && data.artist.length <= 400 ? data.artist.trim() : '';
    const status = await controlSpotify('verify', title + (artist ? ' by ' + artist : ''));
    return { status, title, artist };
  } catch { return { status: 'unconfirmed' }; }
}

function spotifyPlaybackMessage(status: string, query?: string, artist?: string) {
  switch (status) {
    case 'playing': return query ? 'Spotify is playing “' + query + '”' + (artist ? ' by ' + artist : '') + '.' : 'Spotify is playing.';
    case 'paused': return 'Spotify is paused.';
    case 'different-track': return 'Select “' + query + '” in Spotify first. I can play the track once it is loaded.';
    case 'no-match': return 'I couldn’t find a playable result for “' + query + '” in the Spotify window. Select the song there or give me its title and artist.';
    case 'ambiguous': return query ? 'I found multiple matches for “' + query + '”. Give me the full title and artist.' :
      'Windows found several Spotify sessions. Bring the Spotify player you want to the front and try again.';
    case 'no-session': return 'Open Spotify and select a track first.';
    default: return 'I couldn’t confirm the playback change in Spotify.';
  }
}

async function controlDesktop(intent: Extract<Intent, { type: 'window' }>) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(root, 'desktop-window.ps1'), '-Action', intent.action, '-OwnerProcess', String(process.pid)];
  if (intent.action !== 'list') args.push('-EncodedTarget', Buffer.from(intent.target).toString('base64'));
  const result = await new Promise<{ status: string; titles: string[]; more: boolean } | null>(resolve => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 7000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); }
      catch { resolve(null); }
    });
  });
  if (!result) return { message: 'Windows didn’t respond to the desktop command.' };
  const titleList = result.titles.map(title => '“' + title + '”').join(', ') + (result.more ? ', and more' : '');
  switch (result.status) {
    case 'listed': return { message: result.titles.length ? 'Open windows include ' + titleList + '.' : 'I couldn’t find any open app windows.' };
    case 'missing': return { message: 'I couldn’t find an open window with that name.' };
    case 'ambiguous': return { message: 'More than one window matches. Repeat the command with a specific title. ' + titleList + '.' };
    case 'done': {
      const past = { focus: 'Switched to', minimize: 'Minimized', maximize: 'Maximized', restore: 'Restored', list: 'Found' };
      return { message: past[intent.action] + ' ' + titleList + '.' };
    }
    default: return { message: 'I found ' + titleList + ' but couldn’t confirm that Windows completed the action.' };
  }
}

const fileScopes = ['downloads', 'documents', 'desktop'] as const;
const fileScopeLabels = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop' };
let assistantFiles: FileMatch[] = [];
type EditorFile = Pick<FileMatch, 'name' | 'path'>;
let fileConversation: { pet: Pet; files: FileMatch[]; selected?: EditorFile } | undefined;
let renameConversation: { pet: Pet; at: number; target?: EditorFile; newName?: string } | undefined;
let assistantPending = false;
let spotifyConversation: (SpotifyContext & { pet: Pet; at: number }) | undefined;
let projectProposal: { id: string; pet: Pet; source: ProjectSource; content: string; edit: ProjectEdit } | undefined;

type StoredAi = Pick<AiSettingsView, 'enabled' | 'provider' | 'model'> & { secret: string };
const defaultAi: StoredAi = { enabled: false, provider: 'gemini', model: cloudModels.gemini, secret: '' };

function aiSettingsPath() {
  return join(app.getPath('userData'), 'ai-settings.json');
}

function readAiSettings(): StoredAi {
  try {
    const data = JSON.parse(readFileSync(aiSettingsPath(), 'utf8'));
    if (isCloudProvider(data?.provider) && isCloudModel(data.model) && typeof data.secret === 'string') {
      return { enabled: data.enabled === true, provider: data.provider, model: data.model, secret: data.secret };
    }
  } catch { /* First run or unreadable settings. */ }
  return defaultAi;
}

function aiSettingsView(settings = readAiSettings()): AiSettingsView {
  return { enabled: settings.enabled, provider: settings.provider, model: settings.model, hasKey: Boolean(settings.secret), defaults: cloudModels };
}

function storedKey(settings: StoredAi) {
  return settings.secret && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(settings.secret, 'base64')) : '';
}

function readAiInput(input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Invalid AI settings.');
  const data = input as Record<string, unknown>;
  if (!isCloudProvider(data.provider) || !isCloudModel(data.model) || typeof data.enabled !== 'boolean' ||
      typeof data.key !== 'string' || data.key.length > 512 || /\s/.test(data.key.trim())) throw new Error('Invalid AI settings.');
  return { provider: data.provider, model: data.model, enabled: data.enabled, key: data.key.trim() };
}

function saveAiSettings(input: unknown, remove = false) {
  const { provider, model, enabled, key } = readAiInput(input);
  const existing = readAiSettings();
  let secret = provider === existing.provider ? existing.secret : '';
  if (remove) secret = '';
  else if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    secret = safeStorage.encryptString(key).toString('base64');
  }
  const settings = { provider, model, enabled: enabled && Boolean(secret), secret };
  const path = aiSettingsPath();
  writeFileSync(path + '.tmp', JSON.stringify(settings));
  renameSync(path + '.tmp', path);
  return aiSettingsView(settings);
}

function configuredCloud(): CloudConfig | undefined {
  const settings = readAiSettings();
  if (!settings.enabled) return;
  try {
    const key = storedKey(settings);
    if (key) return { provider: settings.provider, model: settings.model, key };
  } catch { /* A Windows account change can make an old key unreadable. */ }
}

function foldersForFile(scope?: FileScope) {
  const documents = app.getPath('documents');
  const generated = join(documents, 'Pet Pocket');
  return scope === 'documents' ? [documents, generated] : scope ? [app.getPath(scope)] : [generated];
}

function namedLocalFiles(name: string, folders: string[]): EditorFile[] {
  const key = name.toLowerCase();
  return folders.flatMap(folder => {
    try {
      const entry = readdirSync(folder, { withFileTypes: true }).find(item => item.isFile() && item.name.toLowerCase() === key);
      return entry ? [{ name: entry.name, path: join(folder, entry.name) }] : [];
    } catch { return []; }
  });
}

function rememberAssistantFile(pet: Pet, path: string) {
  const name = basename(path);
  const folder = dirname(path);
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  const card = { name, folder, modified, canOpen: canOpenAssistantFile(name) };
  const file = { ...card, path };
  assistantFiles = [file];
  fileConversation = { pet, files: assistantFiles, selected: file };
  return card;
}

function matchingFileReferences(pet: Pet, reference: NamedFile) {
  const context = fileConversation?.pet === pet ? fileConversation : undefined;
  const recent = reference.folder ? [] : [context?.selected, ...(context?.files ?? [])].filter(
    (file): file is EditorFile => Boolean(file && file.name.toLowerCase() === reference.name.toLowerCase()),
  );
  const files = recent.length ? recent : namedLocalFiles(reference.name, reference.folder ? foldersForFile(reference.folder) :
    [...foldersForFile('documents'), app.getPath('downloads'), app.getPath('desktop')]);
  return [...new Map(files.map(file => [file.path.toLowerCase(), file])).values()];
}

async function handleRename(pet: Pet, text: string) {
  const pending = renameConversation?.pet === pet && Date.now() - renameConversation.at < 5 * 60_000
    ? renameConversation : undefined;
  renameConversation = undefined;
  const request = renameRequest(text);
  const reference = request ? request.source : namedFileReference(text);
  if (request?.invalidSource) return { message: 'Give me the current filename and, if needed, its folder.' };
  if (!request && !reference?.folder && !(pending && reference)) return;

  if (!request && !pending && reference?.folder) {
    const matches = matchingFileReferences(pet, reference);
    if (matches.length !== 1) return { message: 'I couldn’t find “' + reference.name + '” directly in ' + fileScopeLabels[reference.folder] + '.' };
    const card = rememberAssistantFile(pet, matches[0].path);
    return { message: 'Found “' + card.name + '” in ' + fileScopeLabels[reference.folder] + '. What would you like to do with it?', files: [card] };
  }

  const context = fileConversation?.pet === pet ? fileConversation : undefined;
  const suppliedNewName = !request && pending?.target && !pending.newName && reference && !reference.folder;
  const source = suppliedNewName ? undefined : reference;
  let target = pending?.target ?? context?.selected ?? (context?.files.length === 1 ? context.files[0] : undefined);
  const newName = request?.newName ?? (suppliedNewName ? reference?.name : pending?.newName);
  if (newName !== undefined && !isWindowsFilename(newName)) return { message: 'Use a valid Windows filename for the new name.' };
  if (source) {
    const matches = matchingFileReferences(pet, source);
    if (matches.length !== 1) {
      renameConversation = { pet, at: Date.now(), newName };
      return { message: matches.length ? 'I found more than one file with that name. Which folder is it in?' :
        'I couldn’t find “' + source.name + '”. Give me its current filename and folder.' };
    }
    target = matches[0];
  }
  if (!target || !newName) {
    renameConversation = { pet, at: Date.now(), target, newName };
    return { message: target ? 'What should I rename “' + target.name + '” to?' : 'What is the current filename and folder?' };
  }
  const finalName = extname(newName) ? newName : newName + extname(target.name);
  if (!isWindowsFilename(finalName)) return { message: 'Use a valid Windows filename for the new name.' };
  if (finalName === target.name) return { message: 'The file is already named “' + target.name + '”.' };
  let path: string;
  try {
    path = await renameLocalFile(target.path, finalName);
  } catch {
    const destination = join(dirname(target.path), finalName);
    return { message: target.name.toLowerCase() !== finalName.toLowerCase() && existsSync(destination) ?
      'A file named “' + finalName + '” already exists in that folder. Choose a different name.' :
      'Windows couldn’t rename “' + target.name + '”. Check that the file is still available.' };
  }
  const card = rememberAssistantFile(pet, path);
  return { message: 'Renamed “' + target.name + '” to “' + card.name + '”.', files: [card] };
}

async function previewProjectEdit(pet: Pet, edit: ProjectEdit, cloud: CloudConfig | undefined, onRun?: (run: AiRun) => void) {
  projectProposal = undefined;
  const context = fileConversation?.pet === pet ? fileConversation : undefined;
  let target = context?.selected ?? (context?.files.length === 1 ? context.files[0] : undefined);
  const requestedName = edit.file ?? (edit.folder ? target?.name : undefined);
  if (requestedName !== undefined) {
    const matches = matchingFileReferences(pet, { name: requestedName, folder: edit.folder });
    if (matches.length > 1) return { message: 'I found multiple files named “' + requestedName + '”. Specify its folder or select the file you want.' };
    target = matches[0];
    if (!target && edit.folder) return { message: 'I couldn’t find “' + requestedName + '” in ' + fileScopeLabels[edit.folder] + '.' };
  }
  const name = target?.name ?? edit.file;
  if (!name) return { message: 'Which file should I edit? Give me its filename.' };
  if (!isEditableFile(name)) return { message: 'Choose a supported text or source file to edit.' };
  let folder = target ? dirname(target.path) : '';
  let filename = target?.name ?? name;
  if (!target || edit.test) {
    const choice = await dialog.showOpenDialog(win, { title: 'Select the project folder for ' + name, properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return { message: 'Project selection canceled.' };
    folder = choice.filePaths[0];
    if (target) filename = relative(folder, target.path);
  }
  let source: ProjectSource;
  try { source = await selectProjectSource(folder, filename); }
  catch { return { message: 'I couldn’t read “' + name + '”. Choose an existing UTF-8 text or source file under 8 KB.' }; }
  if (cloud) {
    const approval = await dialog.showMessageBox(win, {
      type: 'question', title: 'Review cloud sharing', message: 'Send this file to ' + cloud.provider + '?',
      detail: source.path + '\n\nPet Pocket will send this file and your edit request to the selected provider. Choose local Qwen to keep the file on this PC.',
      buttons: ['Use local Qwen', 'Send this file', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (approval.response === 2) return { message: 'Project edit canceled.' };
    if (approval.response !== 1) cloud = undefined;
  }
  try {
    const result = await proposeSource({ ...edit, file: name }, source, model, cloud);
    onRun?.(result.fallback ? { engine: result.engine, fallback: result.fallback } : { engine: result.engine });
    if (result.content === source.original) return { message: 'The proposed source matches the current file.' };
    const id = randomUUID();
    projectProposal = { id, pet, source, content: result.content, edit };
    return { message: 'Review the changes to “' + name + '”, then apply them to update the file.', proposal: {
      id, path: source.path, before: source.original, after: result.content, test: edit.test,
    } };
  } catch {
    onRun?.({ engine: 'qwen', ...(cloud ? { fallback: cloud.provider } : {}) });
    return { message: 'I couldn’t prepare a complete edit with Qwen. Check that Ollama is running and try a smaller change.' };
  }
}

async function runProjectTests(folder: string) {
  const npm = process.env.npm_execpath;
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    if (!npm || typeof manifest.scripts?.test !== 'string' || !manifest.scripts.test.trim()) throw new Error();
  } catch {
    return { status: 'Not run', output: 'This workflow requires an npm project with a test script and Pet Pocket started through npm.' };
  }
  return new Promise<{ status: string; output: string }>(resolve => {
    execFile(process.execPath, [npm, 'test'], {
      cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 120_000, maxBuffer: 256_000,
    }, (error, stdout, stderr) => resolve({
      status: error ? 'Failed' : 'Passed',
      output: (stderr + '\n' + stdout).trim().slice(-2400) || (error ? 'The test command did not finish successfully.' : 'The test command exited successfully.'),
    }));
  });
}

async function approveProjectEdit(id: unknown, apply: unknown) {
  const proposal = projectProposal;
  if (!proposal || id !== proposal.id || proposal.pet !== currentPet() || assistantPending) {
    return { message: 'This preview is no longer available. Ask for a new project edit.' };
  }
  projectProposal = undefined;
  if (apply !== true) return { message: 'Project edit discarded.' };
  assistantPending = true;
  try {
    try { await applyProjectSource(proposal.source, proposal.content); }
    catch { return { message: 'I couldn’t apply the edit. The file may have changed since the preview. Request a new edit.' }; }
    const edited = { name: basename(proposal.source.path), folder: dirname(proposal.source.path),
      path: proposal.source.path, modified: Date.now(), canOpen: /\.(?:txt|md|json)$/i.test(proposal.source.path) };
    assistantFiles = [edited];
    fileConversation = { pet: proposal.pet, files: assistantFiles, selected: edited };
    const { path: _editedPath, ...fileCard } = edited;
    let message = 'Updated “' + edited.name + '” on disk.';
    if (!proposal.edit.test) return { message, files: [fileCard] };
    const { status, output } = await runProjectTests(proposal.source.root);
    message += '\nnpm test · ' + status + '\n' + output;
    if (!proposal.edit.report) return { message, files: [fileCard] };
    try {
      const folder = join(app.getPath('documents'), 'Pet Pocket');
      const name = 'project-tests-' + Date.now() + '.xlsx';
      const content = JSON.stringify([['Project', 'File', 'Command', 'Result', 'Output'],
        [basename(proposal.source.root), edited.name, 'npm test', status, output]]);
      const file = await saveGeneratedFile(folder, { name, content });
      assistantFiles = [edited, file];
      fileConversation = { pet: proposal.pet, files: assistantFiles, selected: edited };
      return { message: message + '\nSaved an Excel test report.', files: [fileCard, { name, folder, modified: file.modified, canOpen: file.canOpen }] };
    } catch { return { message: message + '\nWindows couldn’t save the Excel test report.', files: [fileCard] }; }
  } finally { assistantPending = false; }
}

async function openAssistantFileInVSCode(pet: Pet, intent: Extract<Intent, { type: 'open-in-vscode' }>) {
  const context = fileConversation?.pet === pet ? fileConversation : undefined;
  let file = context?.selected ?? (context?.files.length === 1 ? context.files[0] : undefined);
  const name = intent.name ?? (intent.folder ? file?.name : undefined);
  if (name !== undefined) {
    const key = name.toLowerCase();
    const matches = intent.folder ? [] : context?.files.filter(item => item.name.toLowerCase() === key) ?? [];
    if (matches.length > 1) return 'I found multiple files named “' + name + '”. Use Open in VS Code on the result you want.';
    file = matches[0];
    if (!file) file = namedLocalFiles(name, foldersForFile(intent.folder))[0];
    if (!file) {
      const searched = intent.folder === 'documents' ? 'Documents or Documents → Pet Pocket' :
        intent.folder ? fileScopeLabels[intent.folder] : 'the latest results or Documents → Pet Pocket';
      return 'I couldn’t find “' + name + '” in ' + searched + '. Ask me to find it first.';
    }
  }
  if (!file) return 'Which file should I open in VS Code? Give me the filename.';
  const error = await launchVSCode(file.path);
  if (error) return error;
  fileConversation = { pet, files: context?.files ?? [], selected: file };
  return 'Sent “' + file.name + '” to VS Code through Windows.';
}

async function askPet(input: unknown, scope: unknown, onRun?: (run: AiRun) => void) {
  const pet = currentPet();
  if (!pet || !Array.isArray(input) || !input.length || assistantPending) return { message: 'Choose a pet or wait for the current request.' };
  if (scope !== 'all' && scope !== 'downloads' && scope !== 'documents' && scope !== 'desktop') return { message: 'Choose a search folder first.' };
  const turns: Turn[] = [];
  for (const entry of input.slice(-7)) {
    if ((entry?.role === 'user' || entry?.role === 'assistant') && typeof entry.content === 'string') {
      turns.push({ role: entry.role, content: entry.content.slice(0, 1600) });
    }
  }
  if (turns.at(-1)?.role !== 'user' || !turns.at(-1)?.content.trim()) return { message: 'Type a question or command first.' };
  if (/^(?:please\s+)?apply\s+(?:it|the (?:edit|changes|change))[.!]?$/i.test(turns.at(-1)!.content.trim())) {
    if (!projectProposal || projectProposal.pet !== pet) return { message: 'There’s no edit preview to apply. Ask me what to change first.' };
    return approveProjectEdit(projectProposal.id, true);
  }
  assistantPending = true;
  assistantFiles = [];
  projectProposal = undefined;
  const spotify = spotifyConversation?.pet === pet && Date.now() - spotifyConversation.at < 5 * 60_000
    ? spotifyConversation : undefined;
  spotifyConversation = undefined;
  try {
    const rename = await handleRename(pet, turns.at(-1)!.content);
    if (rename) return rename;
    let lastDraft = '';
    let lastDraftAt = 0;
    const petContext = { name: pet.name, food: pet.food, energy: pet.energy, bond: pet.bond, asleep: Boolean(pet.nap) };
    const intent = await interpret(turns, petContext, scope === 'all' ? 'Desktop, Documents and Downloads' : scope, text => {
      if (text === lastDraft || (text && Date.now() - lastDraftAt < 75) || win.isDestroyed()) return;
      lastDraft = text;
      lastDraftAt = Date.now();
      win.webContents.send('assistant-draft', text);
    }, spotify, { cloud: configuredCloud(), onRun, hasFileContext: fileConversation?.pet === pet });
    if (intent.type === 'reply') {
      spotifyConversation = spotify;
      return { message: intent.message };
    }
    if (intent.type === 'window') return await controlDesktop(intent);
    if (intent.type === 'project-edit') return await previewProjectEdit(pet, intent.edit, configuredCloud(), onRun);
    if (intent.type === 'open-in-vscode') {
      const message = await openAssistantFileInVSCode(pet, intent);
      assistantFiles = fileConversation?.pet === pet ? fileConversation.files : [];
      return { message, files: assistantFiles.map(({ name, folder, modified, canOpen }) => ({ name, folder, modified, canOpen })) };
    }
    if (intent.type === 'launch') {
      const result = await command(intent.target);
      if (intent.target === 'spotify' && result.mood === 'headphones') spotifyConversation = { pet, at: Date.now() };
      return result;
    }
    if (intent.type === 'spotify-playback') {
      if (intent.launch) await shell.openExternal('spotify:');
      let status = await controlSpotify(intent.action, intent.query);
      if (intent.launch && status === 'no-session') {
        await delay(1200);
        status = await controlSpotify(intent.action, intent.query);
      }
      const selected = intent.action === 'play' && intent.query && status !== 'playing'
        ? await selectSpotifyResult(intent.query) : undefined;
      if (selected) status = selected.status;
      const title = status === 'playing' ? selected?.title ?? intent.query : intent.query;
      spotifyConversation = { pet, query: title ?? spotify?.query, at: Date.now(),
        ...(status !== 'playing' && (intent.query || spotify?.awaitingSelection) ? { awaitingSelection: true } : {}) };
      return { message: spotifyPlaybackMessage(status, title, selected?.artist), ...(status === 'playing' ? { mood: 'headphones' } : {}) };
    }
    if (intent.type === 'spotify-search') {
      if (intent.play && await controlSpotify('play', intent.query) === 'playing') {
        spotifyConversation = { pet, query: intent.query, at: Date.now() };
        return { message: spotifyPlaybackMessage('playing', intent.query), mood: 'headphones' };
      }
      const query = encodeURIComponent(Buffer.from(intent.query).toString('utf8'));
      try {
        await shell.openExternal('spotify:search:' + query);
      } catch {
        await shell.openExternal('https://open.spotify.com/search/' + query);
        spotifyConversation = { pet, query: intent.query, at: Date.now(), awaitingSelection: true };
        return { message: 'Opened Spotify search for “' + intent.query + '” in your browser.' +
          (intent.play ? ' Select a track there to start playback.' : '') };
      }
      spotifyConversation = { pet, query: intent.query, at: Date.now(), awaitingSelection: true };
      if (!intent.play) return { message: 'Searching Spotify for “' + intent.query + '”.', mood: 'headphones' };
      const { status, title, artist } = await selectSpotifyResult(intent.query);
      if (status === 'playing') spotifyConversation = { pet, query: title ?? intent.query, at: Date.now() };
      return { message: spotifyPlaybackMessage(status, status === 'playing' ? title : intent.query, artist),
        ...(status === 'playing' ? { mood: 'headphones' } : {}) };
    }
    if (intent.type === 'close') return closeSpotify();
    if (intent.type === 'care') {
      if (pet !== currentPet()) return { message: 'Your active pet changed. Ask again.' };
      const reaction = act(pet, intent.action, Date.now());
      save();
      return reaction;
    }
    if (intent.type === 'create-file') {
      const downloads = intent.destination === 'downloads';
      const location = downloads ? 'Downloads' : 'Documents → Pet Pocket';
      try {
        const destination = downloads ? app.getPath('downloads') : join(app.getPath('documents'), 'Pet Pocket');
        const { name, folder, path, modified, canOpen } = await saveGeneratedFile(destination, intent.file);
        assistantFiles = [{ name, folder, path, modified, canOpen }];
        fileConversation = { pet, files: assistantFiles };
        const action = intent.file.content === '' ? 'Created an empty file named' : 'Saved';
        let message = action + ' “' + name + '” in ' + location + '.';
        if (intent.openInVSCode) {
          const editorError = await launchVSCode(path).catch(() => 'Windows couldn’t send this file to VS Code.');
          message += editorError ? ' ' + editorError : ' Sent it to VS Code.';
        }
        return { message, files: [{ name, folder, modified, canOpen }] };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { message: 'A file with that name already exists in ' + location + '. Ask me to use another filename.' };
        }
        return { message: 'Windows couldn’t save the file in ' + location + '.' };
      }
    }
    if (intent.type === 'find') {
      const folders = intent.search.folder ? [intent.search.folder] : scope === 'all' ? fileScopes : [scope] as const;
      const roots = folders.map(folder => app.getPath(folder));
      const result = await findFiles(roots, intent.search);
      assistantFiles = result.files;
      fileConversation = { pet, files: assistantFiles };
      return {
        message: (result.files.length ? 'I found these possible matches.' : 'I didn’t find a match. Try a shorter keyword or a different folder.')
          + (result.limited ? ' The search hit its scan limit, so some folders may still have matches.' : ''),
        files: result.files.map(({ name, folder, modified, canOpen }) => ({ name, folder, modified, canOpen })),
      };
    }
  } catch {
    return { message: 'I could not complete that request. Try again.' };
  } finally {
    assistantPending = false;
  }
}

function save() {
  writeFileSync(savePath + '.tmp', JSON.stringify(home, null, 2));
  renameSync(savePath + '.tmp', savePath);
}
function toggleQuiet() {
  stopRoam();
  home.quiet = !home.quiet;
  if (home.quiet) win.hide();
  else {
    ignoreMouse = true;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.showInactive();
  }
  updateTray();
  save();
}
function returnToScreen() {
  stopRoam(false);
  dragOffset = undefined;
  closeToyStage();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(360, area.width), height = Math.min(580, area.height);
  const x = Math.round(area.x + Math.max(0, area.width - width - 12));
  const y = Math.round(area.y + Math.max(0, area.height - height - 12));
  win.setBounds({ x, y, width, height });
  home.position = { x, y };
  home.quiet = false;
  win.showInactive();
  updateTray();
  save();
}
function changePreferences(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid preferences');
  const previous = home.preferences;
  home.preferences = normalizePreferences({ ...previous, ...input });
  try { save(); } catch (error) { home.preferences = previous; throw error; }
  stopRoam(false);
  if (home.preferences.locked) dragOffset = undefined;
  updateTray();
  void updateWeather();
  return status();
}
function updateTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open controls', click: () => { home.quiet = false; win.showInactive(); win.webContents.send('open-controls'); updateTray(); save(); } },
    { label: 'Return pet to screen', click: returnToScreen },
    { label: 'Lock position', type: 'checkbox', checked: home.preferences.locked, click: () => changePreferences({ locked: !home.preferences.locked }) },
    { label: 'Roaming', submenu: ['off', 'rarely', 'normal', 'often'].map(value => ({
      label: value[0].toUpperCase() + value.slice(1), type: 'radio' as const,
      checked: home.preferences.roamFrequency === value, click: () => changePreferences({ roamFrequency: value }),
    })) },
    { label: 'Feed pet', enabled: Boolean(currentPet()), click: () => { const pet = currentPet(); if (pet) { const reaction = act(pet, 'feed', Date.now()); save(); win.webContents.send('care-feedback', reaction); } } },
    { label: 'Sleep / wake', enabled: Boolean(currentPet()), click: () => { const pet = currentPet(); if (pet) { act(pet, pet.nap ? 'wake' : 'sleep', Date.now()); save(); } } },
    { type: 'separator' },
    { label: 'Quiet Mode', type: 'checkbox', checked: home.quiet, click: toggleQuiet },
    { label: 'Quit Anino', click: () => app.quit() },
  ]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  savePath = join(app.getPath('userData'), 'pet.json');
  try {
    const saved = JSON.parse(readFileSync(savePath, 'utf8'));
    if (saved && typeof saved.pets === 'object' && saved.pets !== null) {
      home = { ...home, ...saved };
      if (!isSpecies(home.active) || !home.pets[home.active]) home.active = null;
    } else if (saved && typeof saved.updated === 'number') {
      const { position, quiet, ...legacy } = saved;
      home.pets.anino = { ...fresh(Date.now()), ...legacy };
      home.position = position ?? null;
      home.quiet = Boolean(quiet);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(error);
  }
  home.preferences = normalizePreferences(home.preferences);
  home.routines = restoreRoutines(home.routines);
  home.todos = restoreTodos(home.todos);
  if (!home.routineRuns || typeof home.routineRuns !== 'object' || Array.isArray(home.routineRuns)) home.routineRuns = {};
  if (home.position && (!Number.isSafeInteger(home.position.x) || !Number.isSafeInteger(home.position.y))) home.position = null;
  home.weatherLocation = normalizeLocation(home.weatherLocation);
  if (!home.weatherLastAlert || typeof home.weatherLastAlert.key !== 'string' || !Number.isFinite(home.weatherLastAlert.time)) home.weatherLastAlert = { key: '', time: 0 };
  weather.location = home.weatherLocation;
  updatePets();
  const area = screen.getDisplayNearestPoint(home.position ?? screen.getCursorScreenPoint()).workArea;
  const width = 360, height = Math.min(580, area.height);
  win = new BrowserWindow({
    x: Math.max(area.x, Math.min(home.position?.x ?? area.x + area.width - width - 12, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(home.position?.y ?? area.y + area.height - height - 12, area.y + area.height - height)),
    width, height, transparent: true, frame: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, show: false,
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  // Polling also restores click-through if the cursor leaves the window abruptly.
  const hitTest = setInterval(() => {
    if (!win.isVisible() || dragOffset) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    if (point.x < bounds.x || point.x >= bounds.x + bounds.width ||
        point.y < bounds.y || point.y >= bounds.y + bounds.height) {
      if (!ignoreMouse) {
        ignoreMouse = true;
        win.setIgnoreMouseEvents(true, { forward: true });
      }
    }
  }, 100);
  ipcMain.handle('roam', (_event, start: boolean) => {
    if (start) return startRoam();
    stopRoam();
    return null;
  });
  ipcMain.on('hit', (_event, interactive: boolean) => {
    if (ignoreMouse === !interactive) return;
    ignoreMouse = !interactive;
    win.setIgnoreMouseEvents(ignoreMouse, { forward: true });
  });
  ipcMain.on('drag', (_event, phase: 'start' | 'move' | 'end') => {
    if (phase === 'end') {
      const wasDragging = Boolean(dragOffset);
      dragOffset = undefined;
      if (wasDragging) {
        const { x, y } = win.getBounds();
        home.position = { x, y };
        try { save(); } catch (error) { console.error('Could not save pet position:', error); }
      }
      return;
    }
    if (toyHome || home.preferences.locked) return;
    // Keep cursor and window positions in Electron's display coordinate system.
    const point = screen.getCursorScreenPoint();
    if (phase === 'start') {
      stopRoam(false);
      const bounds = win.getBounds();
      dragOffset = { x: point.x - bounds.x, y: point.y - bounds.y };
    } else if (phase === 'move' && dragOffset) {
      win.setPosition(point.x - dragOffset.x, point.y - dragOffset.y);
    }
  });
  win.on('moved', () => {
    if (toyHome || roamOrigin) return;
    const { x, y } = win.getBounds();
    home.position = { x, y };
  });
  ipcMain.handle('toy-stage', (_event, open: boolean) => {
    if (!open) {
      closeToyStage();
      return;
    }
    stopRoam();
    toyHome ??= win.getBounds();
    const displays = screen.getAllDisplays().map(display => display.bounds);
    const x = Math.min(toyHome.x, ...displays.map(bounds => bounds.x));
    const y = Math.min(toyHome.y, ...displays.map(bounds => bounds.y));
    const right = Math.max(toyHome.x + toyHome.width, ...displays.map(bounds => bounds.x + bounds.width));
    const bottom = Math.max(toyHome.y + toyHome.height, ...displays.map(bounds => bounds.y + bounds.height));
    win.setResizable(true);
    win.setBounds({ x, y, width: right - x, height: bottom - y });
    const bounds = win.getBounds();
    return {
      right: bounds.x + bounds.width - toyHome.x - toyHome.width,
      bottom: bounds.y + bounds.height - toyHome.y - toyHome.height,
      floors: screen.getAllDisplays().map(({ bounds: display, workArea }) => ({
        left: display.x - bounds.x,
        top: display.y - bounds.y,
        right: display.x + display.width - bounds.x,
        bottom: display.y + display.height - bounds.y,
        floor: workArea.y + workArea.height - bounds.y,
      })),
    };
  });
  win.webContents.on('did-start-loading', () => { rendererIsReady = false; closeToyStage(); });
  const media = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'media.ps1'),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: media.stdout });
  lines.on('line', line => { playing = line.trim() === 'true'; });
  media.stderr.on('data', chunk => console.error(String(chunk).trim()));
  media.on('error', error => console.error('Media monitor:', error.message));
  media.on('exit', () => { playing = false; });
  ipcMain.handle('ask-pet', async (_event, input: unknown, scope: unknown) => {
    let run: AiRun = { engine: 'windows' };
    const reply = await askPet(input, scope, result => { run = result; });
    return { ...reply, run };
  });
  ipcMain.handle('ai-settings', () => aiSettingsView());
  ipcMain.handle('approve-project-edit', (_event, id: unknown, apply: unknown) => approveProjectEdit(id, apply));
  ipcMain.handle('save-ai-settings', (_event, input: unknown, remove: unknown) => saveAiSettings(input, remove === true));
  ipcMain.handle('test-ai-settings', async (_event, input: unknown) => {
    try {
      const data = readAiInput(input);
      const saved = readAiSettings();
      const key = data.key || (saved.provider === data.provider ? storedKey(saved) : '');
      if (!key) return 'Enter an API key first.';
      const reply = await chatCloud({ ...data, key }, 'Reply with OK.', 'Connection test.', [], 128);
      return reply.content?.trim() ? 'Connection successful.' : 'The provider returned an empty reply. Check your model.';
    } catch {
      return 'Connection failed. Check the API key, model, network, and provider quota.';
    }
  });
  ipcMain.handle('assistant-file', async (_event, index: unknown, action: unknown) => {
    if (typeof index !== 'number' || !Number.isInteger(index)) return 'File selection is unavailable.';
    const file = assistantFiles[index];
    if (!file || !existsSync(file.path)) return 'This file is no longer available.';
    if (action === 'reveal') { shell.showItemInFolder(file.path); return ''; }
    if (action === 'open' && file.canOpen) return shell.openPath(file.path);
    if (action === 'vscode') {
      const context = fileConversation;
      const error = await launchVSCode(file.path);
      if (!error && context && context === fileConversation && context.pet === currentPet()) context.selected = file;
      return error;
    }
    return 'Choose Show in folder for this file.';
  });
  ipcMain.handle('setup-notifications', launchNotificationSetup);
  ipcMain.handle('status', status);
  ipcMain.handle('preferences', (_event, input: unknown) => changePreferences(input));
  ipcMain.on('renderer-ready', () => { rendererIsReady = true; checkTodoReminders(); });
  ipcMain.handle('todo', (_event, input: unknown) => {
    const previous = home.todos;
    home.todos = changeTodo(home.todos, input);
    try { save(); } catch (error) { home.todos = previous; throw error; }
    checkTodoReminders();
    return status();
  });
  ipcMain.handle('routines', (_event, input: unknown) => {
    const previous = home.routines;
    home.routines = validateRoutines(input);
    try { save(); } catch (error) { home.routines = previous; throw error; }
    const ids = new Set(home.routines.map(routine => routine.id));
    home.routineRuns = Object.fromEntries(Object.entries(home.routineRuns).filter(([key]) => ids.has(key.split(':')[0])));
    return status();
  });
  ipcMain.handle('customize-pet', (_event, input: unknown) => {
    const pet = currentPet();
    if (!pet || !input || typeof input !== 'object') throw new Error('Choose a pet and customization first.');
    const value = input as { personality: unknown; accessory: unknown };
    const previous = { personality: pet.personality, accessory: pet.accessory };
    customizePet(pet, value.personality, value.accessory);
    try { save(); } catch (error) { Object.assign(pet, previous); throw error; }
    return status();
  });
  ipcMain.handle('return-to-screen', returnToScreen);
  ipcMain.handle('weather-search', (_event, query: unknown) => {
    if (typeof query !== 'string') throw new Error('Enter a city name');
    return searchLocations(query);
  });
  ipcMain.handle('weather-provider', () => shell.openExternal('https://open-meteo.com/'));
  async function setWeatherLocation(input: unknown) {
    const location = input === null ? null : normalizeLocation(input);
    if (input !== null && !location) throw new Error('Invalid weather location');
    const previous = home.weatherLocation;
    home.weatherLocation = location;
    try { save(); } catch (error) { home.weatherLocation = previous; throw error; }
    weather = { location, report: null, error: '', loading: false };
    nextWeatherCheck = 0;
    await weatherRequest;
    lastWeatherAttempt = 0;
    await updateWeather(true);
    return status();
  }
  ipcMain.handle('weather-location', (_event, input: unknown) => setWeatherLocation(input));
  ipcMain.handle('weather-detect', async () => setWeatherLocation(await detectLocation()));
  ipcMain.handle('weather-refresh', async () => { await updateWeather(true); return status(); });
  ipcMain.handle('select-pet', (_event, kind: unknown, input: unknown) => {
    if (!isSpecies(kind) || typeof input !== 'string') throw new Error('Invalid pet selection');
    const name = input.trim();
    if (!name || name.length > 20) throw new Error('Use a name with 1 to 20 characters');
    const pet = home.pets[kind] ?? fresh(Date.now(), kind, name);
    pet.name = name;
    home.pets[kind] = pet;
    home.active = kind;
    const snapshot = status();
    save();
    updateTray();
    return snapshot;
  });
  ipcMain.handle('act', (_event, action: string) => {
    const pet = currentPet();
    if (!pet) throw new Error('Choose a pet first');
    const reaction = act(pet, action, Date.now());
    save();
    return { pet, ...reaction };
  });
  tray = new Tray(nativeImage.createFromPath(join(root, 'icon.png')));
  tray.setToolTip('Anino | Click for Quiet Mode');
  tray.on('click', toggleQuiet);
  updateTray();
  win.once('ready-to-show', () => {
    if (!home.quiet) win.showInactive();
    void offerNotificationSetup().catch(error => console.error('Notification setup:', error));
  });
  void win.loadFile(join(root, 'index.html'));
  const alerts = setInterval(pollWindowsAlerts, 1000);
  const weatherTimer = setInterval(() => { void updateWeather(); }, 60000);
  const routinesTimer = setInterval(updatePets, 15000);
  const todoTimer = setInterval(checkTodoReminders, 5000);
  void updateWeather();
  const autosave = setInterval(() => { updatePets(); save(); }, 30000);
  app.on('before-quit', () => {
    stopRoam();
    media.kill();
    clearInterval(alerts);
    clearInterval(weatherTimer);
    clearInterval(routinesTimer);
    clearInterval(todoTimer);
    clearInterval(autosave);
    clearInterval(hitTest);
    updatePets();
    save();
  });
});






















