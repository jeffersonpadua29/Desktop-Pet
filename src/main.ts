import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { act, advance, fresh, isSpecies, type Pet, type Species } from './pet';

app.setName('Anino');
const root = join(__dirname, '..');
let win: BrowserWindow;
let tray: Tray;
let home = {
  active: null as Species | null,
  pets: {} as Partial<Record<Species, Pet>>,
  position: null as { x: number; y: number } | null,
  quiet: false,
  notificationSetupOffered: false,
};
function currentPet() {
  return home.active ? home.pets[home.active] ?? null : null;
}
function updatePets() {
  const now = Date.now();
  for (const pet of Object.values(home.pets)) if (pet) advance(pet, now);
}
function status() {
  updatePets();
  const names: Partial<Record<Species, string>> = {};
  for (const pet of Object.values(home.pets)) if (pet) names[pet.kind] = pet.name;
  return { pet: currentPet(), playing, names };
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
    if (data.created < startedAt || data.created < now - 15000 || home.quiet || !currentPet() || !win.isVisible()) return;
    win.webContents.send('pet-alert', {
      source: data.source.slice(0, 80),
      message: typeof data.message === 'string' ? data.message.slice(0, 220) : '',
      count: typeof data.count === 'number' && Number.isFinite(data.count) ? Math.max(1, Math.min(3, Math.floor(data.count))) : 1,
    });
  } catch { /* The companion may be offline or replacing its feed. */ }
}

let savePath: string;
let ignoreMouse = true;
let playing = false;
let roamTimer: ReturnType<typeof setInterval> | undefined;
let roamOrigin: Electron.Point | undefined;

function stopRoam(restore = true) {
  if (roamTimer) clearInterval(roamTimer);
  roamTimer = undefined;
  const origin = roamOrigin;
  roamOrigin = undefined;
  if (restore && origin) win.setPosition(origin.x, origin.y);
}

function startRoam() {
  const pet = currentPet();
  if (toyHome || roamTimer || home.quiet || !win.isVisible() || !ignoreMouse || !pet || pet.nap) return null;
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

async function command(input: string) {
  const value = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const target = value.replace(/^(open|buksan) /, '');
  try {
    switch (target) {
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
      default:
        return { message: 'Try open Spotify, open Downloads, or open Calculator.' };
    }
  } catch {
    return { message: 'Windows could not open ' + target + '.' };
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
function updateTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
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
    if (!win.isVisible()) return;
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
  ipcMain.on('drag', (_event, x: number, y: number) => {
    stopRoam(false);
    if (!toyHome && Number.isSafeInteger(x) && Number.isSafeInteger(y)) win.setPosition(x, y);
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
  win.webContents.on('did-start-loading', closeToyStage);
  const media = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'media.ps1'),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: media.stdout });
  lines.on('line', line => { playing = line.trim() === 'true'; });
  media.stderr.on('data', chunk => console.error(String(chunk).trim()));
  media.on('error', error => console.error('Media monitor:', error.message));
  media.on('exit', () => { playing = false; });
  ipcMain.handle('command', (_event, input: string) => command(input));
  ipcMain.handle('setup-notifications', launchNotificationSetup);
  ipcMain.handle('status', status);
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
  const autosave = setInterval(() => { updatePets(); save(); }, 30000);
  app.on('before-quit', () => {
    stopRoam();
    media.kill();
    clearInterval(alerts);
    clearInterval(autosave);
    clearInterval(hitTest);
    updatePets();
    save();
  });
});

















