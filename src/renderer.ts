type PlayDisplay = { left: number; top: number; right: number; bottom: number; floor: number };
type PlayStage = { right: number; bottom: number; floors: PlayDisplay[] };

type Snapshot = import('./pet').Pet;
type Species = import('./pet').Species;
type HomeSnapshot = { pet: Snapshot | null; playing: boolean; names: Partial<Record<Species, string>> };
const api = (window as Window & { anino?: {
  setupNotifications: () => Promise<boolean>;
  onAlert: (callback: (alert: { source: string; message: string; count: number }) => void) => void;
  roam: (start: boolean) => Promise<{ duration: number; facing: string } | null>;
  toyStage: (open: boolean) => Promise<PlayStage | undefined>;
  hit: (hit: boolean) => void;
  drag: (x: number, y: number) => void;
  status: () => Promise<HomeSnapshot>;
  select: (kind: Species, name: string) => Promise<HomeSnapshot>;
  command: (input: string) => Promise<{ message: string; mood?: string }>;
  act: (action: string) => Promise<{ pet: Snapshot; mood: string; message: string }>;
} }).anino!;
const petButton = document.querySelector<HTMLButtonElement>('#pet')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
let reactionUntil = 0;
let nextIdleAt = Date.now() + 3500;
let roamUntil = 0;
let roamTurnAt = 0;
let roamReturnFacing = 'left';
let requestingRoam = false;

function stopIdleRoam() {
  if (!roamUntil && !requestingRoam) return;
  roamUntil = 0;
  delete petButton.dataset.facing;
  void api.roam(false);
}

async function tryIdleMove(state: Snapshot) {
  const now = Date.now();
  if (roamUntil && now >= roamUntil) {
    roamUntil = 0;
    delete petButton.dataset.facing;
  }
  if (roamUntil && now >= roamTurnAt) petButton.dataset.facing = roamReturnFacing;
  const mood = petButton.dataset.mood;
  if (playing || state.nap || !panel.hidden || !petAlert.hidden || busy || aiming || drag || document.hidden) {
    stopIdleRoam();
    return;
  }
  if (requestingRoam || roamUntil || lastHit || now < nextIdleAt || (mood !== 'idle' && mood !== 'happy')) return;
  nextIdleAt = now + 9500 + Math.random() * 13500;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && Math.random() < .42) {
    requestingRoam = true;
    try {
      const movement = await api.roam(true);
      if (movement && panel.hidden && petAlert.hidden && !playing && !aiming && !busy && !drag && !lastHit && !document.hidden) {
        const started = Date.now();
        roamUntil = started + movement.duration;
        roamTurnAt = started + movement.duration / 2;
        roamReturnFacing = movement.facing === 'right' ? 'left' : 'right';
        petButton.dataset.facing = movement.facing;
        petButton.dataset.mood = 'run';
        return;
      }
      if (movement) void api.roam(false);
    } finally { requestingRoam = false; }
  }
  if (panel.hidden && petAlert.hidden && !playing && !aiming && !busy && !drag && !lastHit && !document.hidden) {
    reactionUntil = Date.now() + 1550;
    petButton.dataset.mood = Math.random() < .66 ? 'fidget' : 'look';
  }
}
let playing = false;
let musicSince = 0;
let lastHit = false;
let busy = false;
let aiming = false;
let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined;
let revision = 0;
function setHit(hit: boolean) {
  if (hit === lastHit) return;
  lastHit = hit;
  api.hit(hit);
}
const homePanel = document.querySelector<HTMLElement>('#pet-home')!;
const adoptForm = document.querySelector<HTMLFormElement>('#adopt')!;
const nickname = document.querySelector<HTMLInputElement>('#pet-nickname')!;
const roster = [...document.querySelectorAll<HTMLButtonElement>('[data-kind]')];
const adoptError = document.querySelector<HTMLElement>('#adopt-error')!;
let selected: Species = 'anino';
let active: Snapshot | null = null;
let names: HomeSnapshot['names'] = {};
let picking = false;

function pick(kind: Species) {
  selected = kind;
  nickname.value = names[kind] ?? '';
  nickname.placeholder = { anino: 'Anino', cat: 'Mochi', dog: 'Biscuit', chicken: 'Kislap', ghost: 'Boo', sprout: 'Pip', robot: 'Byte', bunny: 'Mallow', cloud: 'Nimbus' }[kind];
  for (const button of roster) button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
}
function showPicker(show: boolean) {
  picking = show;
  panel.toggleAttribute('data-adopting', show && !active);
  adoptForm.hidden = !show;
  homePanel.hidden = show;
  document.querySelector<HTMLElement>('#cancel-adopt')!.hidden = !active;
  if (show) {
    panel.hidden = false;
    adoptError.hidden = true;
    pick(active?.kind ?? 'anino');
  }
}
function renderHome(state: HomeSnapshot) {
  names = state.names;
  if (state.playing !== playing) musicSince = state.playing ? Date.now() : 0;
  playing = state.playing;
  active = state.pet;
  petButton.hidden = !active;
  if (active) {
    homePanel.hidden = picking;
    render(active);
  }
  else if (!picking) showPicker(true);
}
function render(state: Snapshot) {
  petButton.dataset.kind = state.kind;
  const portrait = document.querySelector<HTMLElement>('#portrait')!;
  portrait.dataset.kind = state.kind;
  petButton.setAttribute('aria-label', state.name + '. Click for controls or drag to move.');
  document.querySelector('#pet-name')!.textContent = state.name;
  for (const key of ['food', 'energy', 'bond'] as const) {
    document.querySelector<HTMLMeterElement>('#' + key)!.value = state[key];
  }
  const hour = new Date().getHours();
  const phase = hour < 6 || hour >= 22 ? 'Late night' : hour < 11 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  document.querySelector('#phase')!.textContent = phase;
  document.querySelector<HTMLElement>('#playing')!.hidden = !playing;
  const hungry = state.food < 30;
  const tired = state.energy < 25;
  const needMood = hungry && (!tired || state.food / 30 <= state.energy / 25) ? 'hungry' : tired ? 'tired' : '';
  portrait.dataset.mood = state.nap ? 'sleep' : needMood;
  const need = document.querySelector<HTMLElement>('#pet-need')!;
  need.textContent = hungry && tired ? 'Hungry and tired' : hungry ? 'Hungry' : tired ? 'Low energy' : '';
  need.hidden = !need.textContent;
  if (aiming) petButton.dataset.mood = 'crouch';
  else if (state.nap) petButton.dataset.mood = 'sleep';
  else if (roamUntil > Date.now()) petButton.dataset.mood = 'run';
  else if (Date.now() >= reactionUntil || (playing && petButton.dataset.mood === 'headphones')) {
    const playful = state.food > 65 && state.energy > 60 && Date.now() % 16000 < 1200;
    const elapsed = Date.now() - musicSince;
    const groove = musicSince > 0 && elapsed >= 7000 && (elapsed - 7000) % 14000 < 2200;
    petButton.dataset.mood = needMood || (playing ? (groove ? 'groove' : 'dance') : phase === 'Late night' && Date.now() >= (state.wakeUntil ?? 0) ? 'sleep' : playful ? (phase === 'Morning' ? 'stretch' : 'happy') : 'idle');
  }
  document.querySelector<HTMLElement>('#event')!.hidden = state.egg !== 'found';
  document.querySelector<HTMLElement>('#clip')!.hidden = !state.items.includes('Moonclip');
  document.querySelector('#items')!.textContent = state.items.join(', ') || 'Collection is empty.';
  document.querySelector('#journal')!.replaceChildren(...state.journal.map(entry => {
    const li = document.createElement('li');
    li.textContent = entry;
    return li;
  }));
  const asleep = Boolean(state.nap) || petButton.dataset.mood === 'sleep';
  const sleepControl = document.querySelector<HTMLButtonElement>('#sleep-control')!;
  sleepControl.dataset.action = asleep ? 'wake' : 'sleep';
  document.querySelector('#sleep-label')!.textContent = asleep ? 'Wake up' : 'Sleep';
  if (asleep) portrait.dataset.mood = 'sleep';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.disabled = busy || (Boolean(state.nap) && button !== sleepControl);
  }
}
function togglePanel() {
  if (aiming && !busy) { void endAim(); return; }
  if (picking || busy) return;
  stopIdleRoam();
  panel.hidden = !panel.hidden;
  petButton.setAttribute('aria-expanded', String(!panel.hidden));
}
document.addEventListener('mousemove', event => {
  setHit(!(aiming && busy) && Boolean(drag || grip || (event.target as Element).closest('[data-hit]')));
});
document.documentElement.addEventListener('mouseleave', () => {
  if (!drag && !grip) setHit(false);
});
petButton.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || aiming) return;
  drag = { id: event.pointerId, x: event.screenX, y: event.screenY, left: window.screenX, top: window.screenY, moved: false };
  petButton.setPointerCapture(event.pointerId);
});
petButton.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) >= 5) drag.moved = true;
  if (drag.moved) api.drag(Math.round(drag.left + dx), Math.round(drag.top + dy));
});
petButton.addEventListener('pointerup', event => {
  if (drag?.id !== event.pointerId) return;
  if (!drag.moved) togglePanel();
  drag = undefined;
});
petButton.addEventListener('lostpointercapture', () => { drag = undefined; });
petButton.addEventListener('click', event => { if (event.detail === 0) togglePanel(); });
const ball = document.querySelector<HTMLElement>('#toy-ball')!;
const toyHint = document.querySelector<HTMLElement>('#toy-hint')!;
let playStage: PlayStage | undefined;
let grip: { id: number; originX: number; originY: number; x: number; y: number } | undefined;

async function endAim() {
  aiming = false;
  grip = undefined;
  toyHint.hidden = true;
  ball.hidden = true;
  ball.style.transform = '';
  await api.toyStage(false);
  playStage = undefined;
  document.documentElement.style.removeProperty('--toy-right');
  document.documentElement.style.removeProperty('--toy-bottom');
  panel.hidden = false;
  petButton.setAttribute('aria-expanded', 'true');
  reactionUntil = 0;
  if (active) render(active);
}

async function startAim() {
  stopIdleRoam();
  petAlert.hidden = true;
  busy = true;
  panel.hidden = true;
  try {
    const stage = await api.toyStage(true);
    if (!stage) throw new Error('Desktop stage is unavailable');
    playStage = stage;
    document.documentElement.style.setProperty('--toy-right', stage.right + 'px');
    document.documentElement.style.setProperty('--toy-bottom', stage.bottom + 'px');
    aiming = true;
    petButton.setAttribute('aria-expanded', 'false');
    petButton.dataset.mood = 'crouch';
    ball.hidden = false;
    toyHint.hidden = false;
    ball.focus({ preventScroll: true });
    setHit(false);
  } catch {
    await endAim();
    document.querySelector('#message')!.textContent = 'Could not open the desktop play area.';
  } finally {
    busy = false;
  }
}

type Pose = [x: number, y: number, opacity?: number];

async function slide(element: HTMLElement, poses: Pose[], duration: number, easing = 'linear') {
  const frames = poses.map(([x, y, opacity = 1]) => ({ transform: `translate(${x}px, ${y}px)`, opacity }));
  const animation = element.animate(frames, { duration, easing, fill: 'forwards' });
  try {
    await animation.finished;
    const last = frames[frames.length - 1];
    element.style.transform = last.transform;
    element.style.opacity = String(last.opacity);
  } finally {
    animation.cancel();
  }
}

function groundAtRelease(x: number, y: number) {
  const screenX = ball.offsetLeft + ball.offsetWidth / 2 + x;
  const screenY = ball.offsetTop + ball.offsetHeight / 2 + y;
  const display = playStage?.floors.find(bounds =>
    screenX >= bounds.left && screenX < bounds.right &&
    screenY >= bounds.top && screenY < bounds.bottom,
  );
  return (display?.floor ?? innerHeight) - ball.offsetTop - ball.offsetHeight - 2;
}

async function dropBall(x: number, y: number, ground: number) {
  const tick = 1000 / 60;
  let height = Math.min(y, ground);
  let velocity = 0;
  const poses: Pose[] = [[x, height]];
  while (height < ground || velocity < 0) {
    velocity += 2600 / 60;
    height += velocity / 60;
    if (height >= ground) {
      height = ground;
      velocity *= -.44;
      if (Math.abs(velocity) < 85) velocity = 0;
    }
    poses.push([x, height]);
  }
  if (poses.length > 1) await slide(ball, poses, (poses.length - 1) * tick);
}

async function throwBall(kind: Species, x: number, releaseY: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const y = groundAtRelease(x, releaseY);
  const direction = x >= 0 ? 1 : -1;
  const face = (sign: number) => { petButton.dataset.facing = sign > 0 ? 'right' : 'left'; };
  const nearX = x - direction * Math.min(43, Math.abs(x));
  const nearY = y - 6;
  const runTime = Math.min(2200, 280 + Math.hypot(x, y) * 1.3);
  const wait = (duration: number) => new Promise<void>(resolve => window.setTimeout(resolve, duration));
  const settled: Pose = [x, y];
  const near: Pose = [nearX, nearY];
  ball.dataset.flight = '';
  face(direction);
  petButton.dataset.mood = 'crouch';
  try {
    // Finish the landing animation before starting any movement of the pet.
    await dropBall(x, releaseY, y);
    await wait(120);

    petButton.dataset.mood = 'run';
    if (kind === 'cat' || kind === 'bunny') {
      const launch: Pose = [nearX * .76, nearY * .76];
      await slide(petButton, [[0, 0], launch], runTime * .72, 'ease-in-out');
      petButton.dataset.mood = 'crouch';
      await wait(170);
      petButton.dataset.mood = 'pounce';
      await slide(petButton, [launch, [nearX * .88, nearY * .88 - 26], near], 260, 'ease-out');
    } else {
      await slide(petButton, [[0, 0], near], runTime, 'ease-in-out');
    }

    petButton.dataset.mood = 'pickup';
    await wait(260);
    if (kind === 'dog' || kind === 'robot') {
      const lifted: Pose = [nearX + direction * 37, nearY - 24];
      await slide(ball, [settled, lifted], 130, 'ease-out');
      face(-direction);
      petButton.dataset.mood = 'carry';
      const mouthX = -direction * 36;
      await slide(ball, [lifted, [nearX, nearY - 30], [nearX + mouthX, nearY - 24]], 115, 'ease-in-out');
      await Promise.all([
        slide(petButton, [near, [0, 0]], runTime, 'ease-in-out'),
        slide(ball, [[nearX + mouthX, nearY - 24], [mouthX, -24]], runTime, 'ease-in-out'),
      ]);
      await slide(ball, [[mouthX, -24], [mouthX, 0], [mouthX - direction * 8, 0, 0]], 250, 'ease-in');
      return;
    }

    face(-direction);
    petButton.dataset.mood = 'run';
    if (kind === 'cat' || kind === 'bunny') {
      await Promise.all([
        slide(ball, [settled, [x * .55, y * .55 - 12], [0, 0, 0]], runTime, 'ease-out'),
        slide(petButton, [near, [0, 0]], runTime, 'ease-in-out'),
      ]);
    } else if (kind === 'chicken' || kind === 'sprout') {
      await Promise.all([
        slide(ball, [settled, [x + direction * 13, y - 5], [x + direction * 19, y, 0]], 280),
        slide(petButton, [near, [0, 0]], runTime, 'ease-in-out'),
      ]);
    } else {
      petButton.dataset.mood = 'crouch';
      await Promise.all([
        slide(ball, [settled, [x, y - 10, 0]], 210),
        slide(petButton, [near, [nearX, nearY - 5, 0]], 210),
      ]);
      await slide(petButton, [[0, 0, 0], [0, 0, 1]], 210, 'ease-out');
    }
  } finally {
    for (const element of [petButton, ball]) {
      element.style.transform = '';
      element.style.opacity = '';
    }
    delete petButton.dataset.facing;
    delete ball.dataset.flight;
  }
}

async function releaseBall(x: number, y: number) {
  if (!aiming || busy) return;
  busy = true;
  revision++;
  grip = undefined;
  setHit(false);
  toyHint.hidden = true;
  try {
    const result = await api.act('throw');

    if (result.mood !== 'sleep') await throwBall(result.pet.kind, x, y);
    active = result.pet;
    document.querySelector('#message')!.textContent = result.message;
    await endAim();
    reactionUntil = Date.now() + 1500;
    petButton.dataset.mood = result.mood;
  } catch {
    await endAim();
    document.querySelector('#message')!.textContent = 'Could not throw the ball. Try again.';
  } finally {
    busy = false;
    if (active) render(active);
  }
}

ball.addEventListener('pointerdown', event => {
  if (!aiming || busy || event.button !== 0) return;
  grip = { id: event.pointerId, originX: event.clientX, originY: event.clientY, x: 0, y: 0 };
  ball.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (grip?.id !== event.pointerId) return;
  grip.x = event.clientX - grip.originX;
  grip.y = event.clientY - grip.originY;
  ball.style.transform = `translate(${grip.x}px, ${grip.y}px)`;
});
document.addEventListener('pointerup', event => {
  if (grip?.id !== event.pointerId) return;
  const x = event.clientX - grip.originX;
  const y = event.clientY - grip.originY;
  grip = undefined;
  if (Math.abs(x) + Math.abs(y) >= 5) void releaseBall(x, y);
  else ball.style.transform = '';
});
ball.addEventListener('lostpointercapture', () => {
  if (!grip) return;
  grip = undefined;
  ball.style.transform = '';
});
ball.addEventListener('click', event => { if (event.detail === 0) void releaseBall(-95, -32); });
document.querySelector('#cancel-toy')!.addEventListener('click', endAim);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && aiming && !busy) void endAim(); });

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', async () => {
    if (busy) return;
    if (button.dataset.action === 'throw') { void startAim(); return; }
    busy = true;
    revision++;
    const message = document.querySelector('#message')!;
    try {
      const action = button.dataset.action!;
      const result = await api.act(action);
      reactionUntil = Date.now() + 1500;
      petButton.dataset.mood = result.mood;
      message.textContent = result.message;
      busy = false;
      render(result.pet);
    } catch {
      busy = false;
      message.textContent = 'Could not save the last action.';
    }
  });
}
async function refresh() {
  if (busy) return;
  const requested = revision;
  const state = await api.status();
  if (requested !== revision) return;
  renderHome(state);
  if (state.pet) await tryIdleMove(state.pet);
}
for (const button of roster) {
  button.addEventListener('click', () => { if (!busy) pick(button.dataset.kind as Species); });
}
document.querySelector('#pick-pet')!.addEventListener('click', () => showPicker(true));
document.querySelector('#cancel-adopt')!.addEventListener('click', () => { if (!busy) showPicker(false); });
adoptForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !nickname.value.trim()) return;
  busy = true;
  revision++;
  try {
    const state = await api.select(selected, nickname.value.trim());
    reactionUntil = 0;
    busy = false;
    renderHome(state);
    showPicker(false);
    petButton.setAttribute('aria-expanded', 'true');
    document.querySelector('#message')!.textContent = state.pet!.name + ' is here.';
  } catch {
    adoptError.textContent = 'Could not save your choice. Try again.';
    adoptError.hidden = false;
  } finally {
    busy = false;
  }
});
void refresh();
setInterval(refresh, 500);

const commandInput = document.querySelector<HTMLInputElement>('#command-input')!;
async function runCommand(input: string) {
  const output = document.querySelector<HTMLElement>('#command-result')!;
  output.hidden = false;
  try {
    const result = await api.command(input);
    output.textContent = result.message;
    if (result.mood && !playing) {
      reactionUntil = Date.now() + 1500;
      petButton.dataset.mood = result.mood;
    }
  } catch {
    output.textContent = 'The desktop command could not run.';
  }
}
document.querySelector('#command')!.addEventListener('submit', event => {
  event.preventDefault();
  if (commandInput.value.trim()) void runCommand(commandInput.value);
});
for (const shortcut of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
  shortcut.addEventListener('click', () => { void runCommand(shortcut.dataset.command!); });
}



const pageButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-page]')];
for (const button of pageButtons) {
  button.addEventListener('click', () => {
    for (const pageButton of pageButtons) {
      const selected = pageButton === button;
      pageButton.setAttribute('aria-pressed', String(selected));
      document.querySelector<HTMLElement>('#page-' + pageButton.dataset.page)!.hidden = !selected;
    }
  });
}


const petAlert = document.querySelector<HTMLElement>('#pet-alert')!;
type SavedAlert = { source: string; message: string; count: number; time: number };
const inboxKey = 'pet-pocket-alerts';
let inbox: SavedAlert[] = [];
try {
  const saved: unknown = JSON.parse(localStorage.getItem(inboxKey) ?? '[]');
  if (Array.isArray(saved)) inbox = saved.slice(0, 20);
} catch { /* The inbox is still available for this session. */ }

function saveInbox() {
  try { localStorage.setItem(inboxKey, JSON.stringify(inbox)); }
  catch { /* Keep the current session's alerts in memory. */ }
}

function renderInbox() {
  const rows = inbox.map(alert => {
    const row = document.createElement('li');
    const source = document.createElement('strong');
    source.textContent = alert.source + (alert.count > 1 ? ' · ' + alert.count + ' alerts' : '');
    const time = document.createElement('time');
    time.textContent = new Date(alert.time).toLocaleString();
    const text = document.createElement('p');
    text.textContent = alert.message || 'Message preview unavailable.';
    row.append(source, time, text);
    return row;
  });
  document.querySelector('#alerts-list')!.replaceChildren(...rows);
  document.querySelector<HTMLElement>('#alerts-empty')!.hidden = inbox.length > 0;
  document.querySelector<HTMLElement>('#clear-alerts')!.hidden = inbox.length === 0;
}

function showPetAlert(source: string, message: string, count = 1) {
  if (!active || document.hidden || aiming) return;
  document.querySelector('#pet-alert-heading')!.textContent = count > 1 ? 'Boss, you have ' + count + ' new alerts.' : 'Boss, an alert from ' + source + '.';
  const body = document.querySelector<HTMLElement>('#pet-alert-message')!;
  body.textContent = message;
  body.hidden = !message;
  stopIdleRoam();
  petAlert.hidden = false;
  if (!active.nap) {
    reactionUntil = Date.now() + 950;
    petButton.dataset.mood = 'surprised';
  }
}

document.querySelector('#preview-notification')!.addEventListener('click', () => {
  showPetAlert('Weather', 'Heavy rain is expected this afternoon.');
});
document.querySelector('#dismiss-alert')!.addEventListener('click', () => { petAlert.hidden = true; });
document.querySelector('#open-alerts')!.addEventListener('click', () => {
  petAlert.hidden = true;
  if (!active || aiming) return;
  if (picking) showPicker(false);
  panel.hidden = false;
  petButton.setAttribute('aria-expanded', 'true');
  document.querySelector<HTMLButtonElement>('[data-page="alerts"]')!.click();
});
document.querySelector('#clear-alerts')!.addEventListener('click', () => {
  inbox = [];
  saveInbox();
  renderInbox();
  petAlert.hidden = true;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopIdleRoam();
    petAlert.hidden = true;
  }
});

renderInbox();
api.onAlert(({ source, message, count }) => {
  inbox = [{ source, message, count, time: Date.now() }, ...inbox].slice(0, 20);
  saveInbox();
  renderInbox();
  showPetAlert(source, message, count);
});





document.querySelector('#setup-notifications')!.addEventListener('click', async () => {
  if (await api.setupNotifications()) return;
  const result = document.querySelector<HTMLElement>('#command-result')!;
  result.textContent = 'Notification setup bundle unavailable. See SETUP.md.';
  result.hidden = false;
});
