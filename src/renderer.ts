type PlayDisplay = { left: number; top: number; right: number; bottom: number; floor: number };
type PlayStage = { right: number; bottom: number; floors: PlayDisplay[] };

type Snapshot = import('./pet').Pet;
type Species = import('./pet').Species;
type Preferences = import('./settings').Preferences;
type WeatherLocation = import('./weather').WeatherLocation;
type WeatherState = import('./weather').WeatherState;
type Routine = import('./routines').Routine;
type RoutineState = import('./routines').RoutineState;
type Companion = ReturnType<typeof import('./pet').companionDetails>;
type HomeSnapshot = { pet: Snapshot | null; playing: boolean; names: Partial<Record<Species, string>>; preferences: Preferences; quietHoursActive: boolean; weather: WeatherState; routines: Routine[]; routine: RoutineState; companion: Companion | null; todos: import('./todos').Todo[] };
type AskTurn = { role: 'user' | 'assistant'; content: string };
type AskFile = { name: string; folder: string; modified: number; canOpen: boolean };
type AiSettingsView = import('./cloud-ai').AiSettingsView;
type CloudProvider = import('./cloud-ai').CloudProvider;
type EditPreview = { id: string; path: string; before: string; after: string; test: boolean };
type AskReply = { message: string; mood?: string; files?: AskFile[]; proposal?: EditPreview; run?: import('./cloud-ai').AiRun };

const api = (window as Window & { anino?: {
  onAssistantDraft: (callback: (text: string) => void) => void;
  askPet: (turns: AskTurn[], scope: string) => Promise<AskReply>;
  aiSettings: () => Promise<AiSettingsView>;
  saveAiSettings: (input: unknown, remove: boolean) => Promise<AiSettingsView>;
  testAiSettings: (input: unknown) => Promise<string>;
  approveProjectEdit: (id: string, apply: boolean) => Promise<AskReply>;
  assistantFile: (index: number, action: string) => Promise<string>;
  setupNotifications: () => Promise<boolean>;
  onAlert: (callback: (alert: { source: string; message: string; count: number; silent: boolean; kind?: 'desktop' | 'weather' | 'reminder' }) => void) => void;
  onOpenControls: (callback: () => void) => void;
  onCareFeedback: (callback: (reaction: { mood: string; message: string }) => void) => void;
  preferences: (input: Preferences) => Promise<HomeSnapshot>;
  ready: () => void;
  todo: (input: import('./todos').TodoChange) => Promise<HomeSnapshot>;
  routines: (input: Routine[]) => Promise<HomeSnapshot>;
  customizePet: (input: { personality: string; accessory: string }) => Promise<HomeSnapshot>;
  returnToScreen: () => Promise<void>;
  weatherSearch: (query: string) => Promise<WeatherLocation[]>;
  weatherLocation: (location: WeatherLocation | null) => Promise<HomeSnapshot>;
  weatherDetect: () => Promise<HomeSnapshot>;
  weatherRefresh: () => Promise<HomeSnapshot>;
  weatherProvider: () => Promise<void>;
  roam: (start: boolean) => Promise<{ duration: number; facing: string } | null>;
  toyStage: (open: boolean) => Promise<PlayStage | undefined>;
  hit: (hit: boolean) => void;
  drag: (phase: 'start' | 'move' | 'end') => void;
  status: () => Promise<HomeSnapshot>;
  select: (kind: Species, name: string) => Promise<HomeSnapshot>;
  act: (action: string) => Promise<{ pet: Snapshot; mood: string; message: string }>;
} }).anino!;
const petButton = document.querySelector<HTMLButtonElement>('#pet')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
let preferences: Preferences;
let quietHoursActive = false;
const preferencesForm = document.querySelector<HTMLFormElement>('#preferences')!;
let preferencesDirty = false;
let renderedPreferences = '';
let weatherAction = false;
let weatherNotice = '';
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let routines: Routine[] = [];
let routine: RoutineState = { active: null, occurrence: '', ends: 0 };
let currentWeatherScene: import('./weather').WeatherScene | 'none' = 'none';
let renderedRoutines = '';
let editingRoutineId: string | null = null;
let routineBusy = false;
let companionDirty = false;
let renderedCompanion = '';
let companionPetKind = '';

function feedback(message: string) {
  clearTimeout(feedbackTimer);
  const label = document.querySelector<HTMLElement>('#pet-feedback')!;
  label.textContent = message;
  label.hidden = false;
  feedbackTimer = setTimeout(() => { label.hidden = true; }, 2800);
}

function renderPreferences(state: HomeSnapshot) {
  const previewsChanged = preferences?.alertPreviews !== state.preferences.alertPreviews;
  preferences = state.preferences;
  quietHoursActive = state.quietHoursActive;
  document.documentElement.style.setProperty('--pet-scale', String({ small: .75, medium: 1, large: 1.25 }[preferences.size]));
  petButton.toggleAttribute('data-locked', preferences.locked);
  const serialized = JSON.stringify(preferences);
  if (!preferencesDirty && serialized !== renderedPreferences) {
    for (const [name, value] of Object.entries(preferences)) {
      const control = preferencesForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = String(value);
    }
    renderedPreferences = serialized;
  }
  document.querySelector('#quiet-status')!.textContent = quietHoursActive ? 'A quiet period is active. Alerts are saved to your inbox.' : '';
  if (quietHoursActive || !preferences.alertPopups) petAlert.hidden = true;
  if (!preferences.alertPreviews) document.querySelector<HTMLElement>('#pet-alert-message')!.hidden = true;
  if (previewsChanged) renderInbox();
}

function renderWeather(state: WeatherState) {
  currentWeatherScene = preferences.weatherReactions && state.location && state.report && !state.error && Date.now() - state.report.updated <= 3600000 ? state.report.scene ?? 'none' : 'none';
  document.querySelector<HTMLElement>('.display')!.dataset.weather = currentWeatherScene;
  const weatherReaction = document.querySelector<HTMLElement>('#weather-reaction')!;
  const labels = { none: '', clear: 'Clear skies', cloudy: 'Cloudy surroundings', rain: 'Rainy day · umbrella ready', storm: 'Stormy skies · umbrella ready', snow: 'Snowy day · bundled up', cold: 'Chilly weather · keeping warm', hot: 'Warm weather · taking it easy', wind: 'Windy surroundings' };
  weatherReaction.textContent = labels[currentWeatherScene];
  weatherReaction.hidden = currentWeatherScene === 'none';
  document.querySelector('#weather-location')!.textContent = state.location ? state.location.name + (state.location.source === 'ip' ? ' (approximate)' : '') : 'Choose your location below.';
  document.querySelector('#weather-report')!.textContent = state.report ? Math.round(state.report.temperature) + ' °C · ' + state.report.summary + '. ' + state.report.advisory : '';
  document.querySelector('#weather-updated')!.textContent = state.report ? 'Updated ' + new Date(state.report.updated).toLocaleString() : '';
  if (!weatherAction) document.querySelector('#weather-error')!.textContent = state.error || weatherNotice || (state.loading ? 'Updating weather…' : '');
  document.querySelector<HTMLButtonElement>('#weather-refresh')!.disabled = weatherAction || state.loading || !state.location;
  document.querySelector<HTMLElement>('#weather-clear')!.hidden = !state.location;
}
let reactionUntil = 0;
let nextIdleAt = Date.now() + 3500;
let roamUntil = 0;
let roamTurnAt = 0;
let roamReturnFacing = 'left';
let requestingRoam = false;

function movementPaused() {
  return preferences.locked || effectiveRoaming() === 'off' || quietHoursActive;
}

function effectiveRoaming() {
  if (routine.active?.activity === 'roam') return preferences.roamFrequency === 'off' ? 'normal' : preferences.roamFrequency;
  if (routine.active) return 'off';
  return preferences.roamFrequency;
}

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
  if (movementPaused() || playing || state.nap || !panel.hidden || !petAlert.hidden || busy || aiming || drag || document.hidden) {
    stopIdleRoam();
    return;
  }
  if (requestingRoam || roamUntil || lastHit || now < nextIdleAt || (mood !== 'idle' && mood !== 'happy')) return;
  const personalityPace = { curious: .8, playful: .9, gentle: 1.25, dreamy: 1.5 }[state.personality];
  const interval = { off: 0, rarely: 60000, normal: 9500, often: 3500 }[effectiveRoaming()] * personalityPace;
  nextIdleAt = now + interval + Math.random() * interval;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && Math.random() < .42) {
    requestingRoam = true;
    try {
      const movement = await api.roam(true);
      if (movement && !movementPaused() && panel.hidden && petAlert.hidden && !playing && !aiming && !busy && !drag && !lastHit && !document.hidden) {
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
  if (!movementPaused() && panel.hidden && petAlert.hidden && !playing && !aiming && !busy && !drag && !lastHit && !document.hidden) {
    reactionUntil = Date.now() + 1550;
    petButton.dataset.mood = state.personality === 'playful' ? 'happy' : state.personality === 'dreamy' ? 'look' : Math.random() < .66 ? 'fidget' : 'look';
  }
}
let playing = false;
let musicSince = 0;
let lastHit = false;
let busy = false;
let aiming = false;
let drag: { id: number; x: number; y: number; moved: boolean } | undefined;
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
  routines = state.routines;
  routine = state.routine;
  renderPreferences(state);
  renderWeather(state.weather);
  renderRoutines();
  configureTodos(state.todos);
  names = state.names;
  if (state.playing !== playing) musicSince = state.playing ? Date.now() : 0;
  playing = state.playing;
  active = state.pet;
  renderCompanion(state);
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
  petButton.setAttribute('aria-label', state.name + (preferences.locked ? '. Position locked. Click for controls.' : '. Click for controls or drag to move.'));
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
  const playtime = routine.active?.activity === 'play' && !quietHoursActive && !state.nap && state.energy >= 8;
  const need = document.querySelector<HTMLElement>('#pet-need')!;
  need.textContent = hungry && tired ? 'Hungry and tired' : hungry ? 'Hungry' : tired ? 'Low energy' : '';
  need.hidden = !need.textContent;
  if (drag && !preferences.locked) petButton.dataset.mood = 'carry';
  else if (aiming) petButton.dataset.mood = 'crouch';
  else if (state.nap) petButton.dataset.mood = 'sleep';
  else if (roamUntil > Date.now()) petButton.dataset.mood = 'run';
  else if (playtime && Date.now() >= reactionUntil) petButton.dataset.mood = 'happy';
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
  petButton.dataset.weather = !asleep && !drag && !busy && !aiming ? currentWeatherScene : 'none';
  document.documentElement.style.setProperty('--weather-clearance', petButton.dataset.weather === 'rain' || petButton.dataset.weather === 'storm' ? '25px' : '0px');
  petButton.dataset.accessory = state.accessory;
  petButton.toggleAttribute('data-routine-play', playtime && !drag && !busy && !aiming);
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
  if (!preferences.locked) api.drag('start');
  stopIdleRoam();
  drag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
  if (preferences.locked) feedback('Position locked. Unlock in Settings.');
  else {
    petButton.dataset.dragging = '';
    petButton.dataset.weather = 'none';
    petButton.removeAttribute('data-routine-play');
    petButton.dataset.mood = 'carry';
  }
  petButton.setPointerCapture(event.pointerId);
});
petButton.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId || preferences.locked) return;
  const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) >= 5) drag.moved = true;
  if (drag.moved) api.drag('move');
});
petButton.addEventListener('pointerup', event => {
  if (drag?.id !== event.pointerId) return;
  if (!drag.moved) togglePanel();
  else {
    reactionUntil = Date.now() + 900;
    petButton.dataset.mood = active?.nap ? 'sleep' : 'happy';
    feedback('Settled in!');
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) document.querySelector('.pet-art')!.animate([{ translate: '0 -3px' }, { translate: '0 0' }], { duration: 220, easing: 'ease-out' });
  }
  drag = undefined;
  delete petButton.dataset.dragging;
});
petButton.addEventListener('lostpointercapture', () => {
  drag = undefined;
  delete petButton.dataset.dragging;
  api.drag('end');
  nextIdleAt = Date.now() + 3500;
});
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
  petButton.dataset.weather = 'none';
  petButton.removeAttribute('data-routine-play');
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
      feedback(result.message);
      busy = false;
      render(result.pet);
    } catch {
      busy = false;
      message.textContent = 'Could not save the last action.';
    }
  });
}
let rendererReady = false;
async function refresh() {
  if (busy) return;
  const requested = revision;
  const state = await api.status();
  if (requested !== revision) return;
  renderHome(state);
  if (!rendererReady) { rendererReady = true; api.ready(); }
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
type SavedAlert = { source: string; message: string; count: number; time: number; kind?: 'desktop' | 'weather' | 'reminder' };
let currentAlertKind: SavedAlert['kind'];
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
    text.textContent = preferences?.alertPreviews === false ? 'Message previews are hidden.' : alert.message || 'Message preview unavailable.';
    row.append(source, time, text);
    return row;
  });
  document.querySelector('#alerts-list')!.replaceChildren(...rows);
  document.querySelector<HTMLElement>('#alerts-empty')!.hidden = inbox.length > 0;
  document.querySelector<HTMLElement>('#clear-alerts')!.hidden = inbox.length === 0;
}

function showPetAlert(source: string, message: string, count = 1) {
  if (!active || document.hidden || aiming || drag || quietHoursActive || preferences?.alertPopups === false) return;
  document.querySelector('#pet-alert-heading')!.textContent = count > 1 ? 'Boss, you have ' + count + ' new alerts.' : 'Boss, an alert from ' + source + '.';
  const body = document.querySelector<HTMLElement>('#pet-alert-message')!;
  body.textContent = preferences?.alertPreviews === false ? '' : message;
  body.hidden = !body.textContent;
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
  document.querySelector<HTMLButtonElement>(currentAlertKind === 'reminder' ? '[data-page="todos"]' : '[data-page="alerts"]')!.click();
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
api.onAlert(({ source, message, count, silent, kind = 'desktop' }) => {
  inbox = [{ source, message, count, kind, time: Date.now() }, ...inbox].slice(0, 20);
  saveInbox();
  renderInbox();
  if (!silent) {
    currentAlertKind = kind;
    document.querySelector('#open-alerts')!.textContent = kind === 'reminder' ? 'Open to-do' : 'Open alerts';
    showPetAlert(source, message, count);
  }
});

preferencesForm.addEventListener('input', () => { preferencesDirty = true; });
preferencesForm.addEventListener('submit', async event => {
  event.preventDefault();
  const result = document.querySelector('#settings-result')!;
  const values: Record<string, string | boolean> = {};
  for (const name of Object.keys(preferences)) {
    const control = preferencesForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    values[name] = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
  }
  const controls = [...preferencesForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')];
  controls.forEach(control => { control.disabled = true; });
  revision++;
  try {
    const state = await api.preferences(values as Preferences);
    preferencesDirty = false;
    renderHome(state);
    result.textContent = 'Settings saved.';
  } catch { result.textContent = 'Could not save settings. Try again.'; }
  finally { controls.forEach(control => { control.disabled = false; }); }
});

document.querySelector('#return-to-screen')!.addEventListener('click', async () => {
  try { await api.returnToScreen(); feedback('Back on screen!'); }
  catch { document.querySelector('#settings-result')!.textContent = 'Could not reposition the pet.'; }
});
api.onOpenControls(() => {
  if (busy) return;
  if (aiming) { void endAim(); return; }
  stopIdleRoam();
  panel.hidden = false;
  petButton.setAttribute('aria-expanded', 'true');
});
api.onCareFeedback(reaction => {
  if (busy || aiming || drag) return;
  reactionUntil = Date.now() + 1500;
  petButton.dataset.mood = reaction.mood;
  document.querySelector('#message')!.textContent = reaction.message;
  feedback(reaction.message);
});

async function weatherTask(action: () => Promise<void>) {
  if (weatherAction) return;
  weatherAction = true;
  const controls = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.weather-card button, .weather-card input')];
  controls.forEach(control => { control.disabled = true; });
  weatherNotice = 'Updating…';
  document.querySelector('#weather-error')!.textContent = weatherNotice;
  try { await action(); }
  catch {
    weatherNotice = 'Could not update weather. Check your connection and try again.';
    document.querySelector('#weather-error')!.textContent = weatherNotice;
  }
  finally {
    weatherAction = false;
    controls.forEach(control => { control.disabled = false; });
  }
}
document.querySelector('#weather-search')!.addEventListener('submit', event => {
  event.preventDefault();
  void weatherTask(async () => {
    const results = await api.weatherSearch(document.querySelector<HTMLInputElement>('#weather-city')!.value);
    document.querySelector('#weather-results')!.replaceChildren(...results.map(location => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = location.name;
      button.addEventListener('click', () => {
        void weatherTask(async () => {
          const state = await api.weatherLocation(location);
          renderHome(state);
          document.querySelector('#weather-results')!.replaceChildren();
          weatherNotice = '';
          document.querySelector('#weather-error')!.textContent = state.weather.error;
        });
      });
      return button;
    }));
    weatherNotice = results.length ? 'Choose a location above.' : 'No matching cities. Try a nearby city or add a country.';
    document.querySelector('#weather-error')!.textContent = weatherNotice;
  });
});
for (const [selector, action] of [
  ['#weather-detect', () => api.weatherDetect()],
  ['#weather-refresh', () => api.weatherRefresh()],
  ['#weather-clear', () => api.weatherLocation(null)],
] as const) {
  document.querySelector(selector)!.addEventListener('click', () => {
    void weatherTask(async () => {
      const state = await action();
      renderHome(state);
      document.querySelector('#weather-results')!.replaceChildren();
      weatherNotice = '';
      document.querySelector('#weather-error')!.textContent = state.weather.error;
    });
  });
}
document.querySelector('#weather-provider')!.addEventListener('click', event => { event.preventDefault(); void api.weatherProvider(); });

function renderRoutines() {
  const status = document.querySelector('#routine-active')!;
  const text = routine.active ? routine.active.name + ' · ' + routine.active.activity + ' until ' + new Date(routine.ends).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'No routine is active.';
  if (status.textContent !== text) status.textContent = text;
  const serialized = JSON.stringify(routines);
  if (renderedRoutines === serialized) return;
  renderedRoutines = serialized;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  document.querySelector('#routines-list')!.replaceChildren(...routines.map(item => {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = item.name + (item.enabled ? '' : ' (paused)');
    const details = document.createElement('p');
    details.textContent = item.activity + ' · ' + item.days.map(day => weekdays[day]).join(', ') + ' · ' + item.start + '–' + item.end;
    const actions = document.createElement('div');
    actions.className = 'settings-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = item.enabled ? 'Pause' : 'Enable';
    toggle.addEventListener('click', () => { void saveRoutines(routines.map(value => value.id === item.id ? { ...value, enabled: !value.enabled } : value)); });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      if (routineBusy) return;
      editingRoutineId = item.id;
      document.querySelector<HTMLInputElement>('#routine-name')!.value = item.name;
      document.querySelector<HTMLSelectElement>('#routine-activity')!.value = item.activity;
      document.querySelector<HTMLInputElement>('#routine-start')!.value = item.start;
      document.querySelector<HTMLInputElement>('#routine-end')!.value = item.end;
      for (const day of document.querySelectorAll<HTMLInputElement>('#routine-editor [name="day"]')) day.checked = item.days.includes(Number(day.value));
      document.querySelector('#routine-save')!.textContent = 'Save routine';
      document.querySelector<HTMLElement>('#routine-cancel')!.hidden = false;
      document.querySelector('#routine-editor')!.scrollIntoView({ block: 'nearest' });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (await saveRoutines(routines.filter(value => value.id !== item.id)) && editingRoutineId === item.id) resetRoutineEditor();
    });
    actions.append(toggle, edit, remove);
    row.append(name, details, actions);
    return row;
  }));
}

async function saveRoutines(input: Routine[]) {
  if (routineBusy) return false;
  routineBusy = true;
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.routine-card input, .routine-card button, .routine-card select')];
  controls.forEach(control => { control.disabled = true; });
  revision++;
  try {
    renderHome(await api.routines(input));
    document.querySelector('#routine-result')!.textContent = 'Routines saved.';
    return true;
  } catch {
    document.querySelector('#routine-result')!.textContent = 'Could not save routines. Try again.';
    return false;
  } finally {
    routineBusy = false;
    controls.forEach(control => { control.disabled = false; });
  }
}

function resetRoutineEditor() {
  editingRoutineId = null;
  document.querySelector<HTMLFormElement>('#routine-editor')!.reset();
  document.querySelector('#routine-save')!.textContent = 'Add routine';
  document.querySelector<HTMLElement>('#routine-cancel')!.hidden = true;
}
document.querySelector('#routine-cancel')!.addEventListener('click', resetRoutineEditor);
document.querySelector('#routine-editor')!.addEventListener('submit', async event => {
  event.preventDefault();
  const days = [...document.querySelectorAll<HTMLInputElement>('#routine-editor [name="day"]:checked')].map(day => Number(day.value));
  const start = document.querySelector<HTMLInputElement>('#routine-start')!.value;
  const end = document.querySelector<HTMLInputElement>('#routine-end')!.value;
  if (!days.length || start === end || (!editingRoutineId && routines.length >= 12)) {
    document.querySelector('#routine-result')!.textContent = 'Select at least one weekday, use different times, and keep at most 12 routines.';
    return;
  }
  const previous = routines.find(item => item.id === editingRoutineId);
  const item: Routine = {
    id: editingRoutineId ?? crypto.randomUUID(), name: document.querySelector<HTMLInputElement>('#routine-name')!.value.trim(),
    activity: document.querySelector<HTMLSelectElement>('#routine-activity')!.value as Routine['activity'],
    start, end, days, enabled: previous?.enabled ?? true,
  };
  const updated = editingRoutineId ? routines.map(value => value.id === editingRoutineId ? item : value) : [...routines, item];
  if (await saveRoutines(updated)) resetRoutineEditor();
});

function renderCompanion(state: HomeSnapshot) {
  if (!state.pet || !state.companion) return;
  const details = state.companion;
  document.querySelector('#friendship-tier')!.textContent = details.tier + ' · ' + Math.round(state.pet.bond) + '/100 friendship';
  document.querySelector('#favorite-activity')!.textContent = details.personality + ' · Favorite activity — ' + details.favorite;
  document.querySelector('#pet-habit')!.textContent = details.habit;
  document.querySelector('#next-milestone')!.textContent = details.next;
  if (companionPetKind !== state.pet.kind) {
    companionDirty = false;
    companionPetKind = state.pet.kind;
    renderedCompanion = '';
    document.querySelector('#companion-result')!.textContent = '';
  }
  const serialized = JSON.stringify([state.pet.kind, state.pet.personality, state.pet.accessory, details.accessories]);
  if (companionDirty || renderedCompanion === serialized) return;
  renderedCompanion = serialized;
  document.querySelector<HTMLSelectElement>('#pet-personality')!.value = state.pet.personality;
  const select = document.querySelector<HTMLSelectElement>('#pet-accessory')!;
  select.replaceChildren(...details.accessories.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name + (item.unlocked ? '' : ' · unlocks at ' + item.bond);
    option.disabled = !item.unlocked;
    return option;
  }));
  select.value = state.pet.accessory;
}
const companionEditor = document.querySelector<HTMLFormElement>('#companion-editor')!;
companionEditor.addEventListener('change', () => { companionDirty = true; });
companionEditor.addEventListener('submit', async event => {
  event.preventDefault();
  const controls = [...companionEditor.querySelectorAll<HTMLSelectElement | HTMLButtonElement>('select, button')];
  controls.forEach(control => { control.disabled = true; });
  revision++;
  try {
    const state = await api.customizePet({ personality: document.querySelector<HTMLSelectElement>('#pet-personality')!.value, accessory: document.querySelector<HTMLSelectElement>('#pet-accessory')!.value });
    companionDirty = false;
    renderHome(state);
    document.querySelector('#companion-result')!.textContent = 'Companion saved.';
  } catch { document.querySelector('#companion-result')!.textContent = 'Could not save your companion. Check that the accessory is unlocked.'; }
  finally { controls.forEach(control => { control.disabled = false; }); }
});





document.querySelector('#setup-notifications')!.addEventListener('click', async () => {
  if (await api.setupNotifications()) return;
  const result = document.querySelector<HTMLElement>('#notification-setup-result')!;
  result.textContent = 'Notification setup bundle unavailable. See SETUP.md.';
  result.hidden = false;
});

const askForm = document.querySelector<HTMLFormElement>('#ask-form')!;
const askEngine = document.querySelector<HTMLElement>('#ask-engine')!;
const aiForm = document.querySelector<HTMLFormElement>('#ai-settings')!;
const aiEnabled = document.querySelector<HTMLInputElement>('#ai-enabled')!;
const aiProvider = document.querySelector<HTMLSelectElement>('#ai-provider')!;
const aiModel = document.querySelector<HTMLInputElement>('#ai-model')!;
const aiKey = document.querySelector<HTMLInputElement>('#ai-key')!;
const aiResult = document.querySelector<HTMLElement>('#ai-result')!;
const aiRemove = document.querySelector<HTMLButtonElement>('#ai-remove')!;
const providerNames = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic' };
let aiSettings: AiSettingsView | undefined;

function showAiSettings(settings: AiSettingsView) {
  aiSettings = settings;
  aiEnabled.checked = settings.enabled;
  aiProvider.value = settings.provider;
  aiModel.value = settings.model;
  aiKey.value = '';
  aiKey.placeholder = settings.hasKey ? 'Key saved on this PC' : 'Enter your provider key';
  aiRemove.hidden = !settings.hasKey;
  askEngine.textContent = settings.enabled ? 'HYBRID · ' + providerNames[settings.provider] : 'LOCAL · QWEN3';
}

function aiFormValues() {
  return { enabled: aiEnabled.checked, provider: aiProvider.value, model: aiModel.value.trim(), key: aiKey.value };
}

async function updateAiSettings(action: 'save' | 'test' | 'remove') {
  if (!aiForm.reportValidity()) return;
  const values = aiFormValues();
  const controls = [...aiForm.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')];
  controls.forEach(control => { control.disabled = true; });
  aiResult.textContent = action === 'test' ? 'Testing provider…' : 'Saving…';
  try {
    if (action === 'test') aiResult.textContent = await api.testAiSettings(values);
    else {
      const settings = await api.saveAiSettings(values, action === 'remove');
      showAiSettings(settings);
      aiResult.textContent = action === 'remove' ? 'Key removed. Using local Qwen.' :
        values.enabled && !settings.hasKey ? 'Enter a key to enable hybrid AI. Using local Qwen.' : 'AI settings saved.';
    }
  } catch {
    aiResult.textContent = 'Could not save AI settings. Check the model ID and Windows credential storage.';
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}

void api.aiSettings().then(showAiSettings).catch(() => { aiResult.textContent = 'Could not load AI settings.'; });
aiProvider.addEventListener('change', () => {
  const provider = aiProvider.value as CloudProvider;
  aiModel.value = (provider === aiSettings?.provider ? aiSettings.model : aiSettings?.defaults[provider]) ?? '';
  aiKey.value = '';
  const saved = provider === aiSettings?.provider && aiSettings.hasKey;
  aiKey.placeholder = saved ? 'Key saved on this PC' : 'Enter your provider key';
  aiRemove.hidden = !saved;
});
aiForm.addEventListener('submit', event => { event.preventDefault(); void updateAiSettings('save'); });
document.querySelector('#ai-test')!.addEventListener('click', () => { void updateAiSettings('test'); });
aiRemove.addEventListener('click', () => { void updateAiSettings('remove'); });
const askInput = document.querySelector<HTMLInputElement>('#ask-input')!;
const askSend = document.querySelector<HTMLButtonElement>('#ask-send')!;
const askScope = document.querySelector<HTMLSelectElement>('#ask-scope')!;
const askChat = document.querySelector<HTMLElement>('#ask-chat')!;
const askStream = document.querySelector<HTMLElement>('#ask-stream')!;
const askEmpty = document.querySelector<HTMLElement>('#ask-empty')!;
const askFiles = document.querySelector<HTMLElement>('#ask-files')!;
const askProposal = document.querySelector<HTMLElement>('#ask-proposal')!;
const askStatus = document.querySelector<HTMLElement>('#ask-status')!;
const askDraft = document.createElement('p');
askDraft.dataset.role = 'assistant';
askDraft.hidden = true;
api.onAssistantDraft(text => {
  if (!askSend.disabled) return;
  if (!text) { askDraft.remove(); return; }
  askDraft.hidden = false;
  askDraft.textContent = text;
  if (!askDraft.isConnected) askChat.append(askDraft);
  askStatus.textContent = 'Responding…';
  askStream.scrollTop = askStream.scrollHeight;
});
const askTurns: AskTurn[] = [];

function addAskTurn(role: AskTurn['role'], content: string) {
  askTurns.push({ role, content });
  if (askTurns.length > 20) askTurns.shift();
  const bubble = document.createElement('p');
  bubble.dataset.role = role;
  bubble.textContent = content;
  askChat.append(bubble);
  askEmpty.hidden = true;
  if (askChat.children.length > 20) askChat.firstElementChild?.remove();
  askStream.scrollTop = askStream.scrollHeight;
}

function showAskFiles(files: AskFile[]) {
  askFiles.replaceChildren(...files.map((file, index) => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = file.name;
    const details = document.createElement('p');
    details.textContent = file.folder + ' · Modified ' + new Date(file.modified).toLocaleString();
    const actions = document.createElement('div');
    actions.className = 'settings-row';
    const addAction = (label: string, action: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        try { askStatus.textContent = await api.assistantFile(index, action); }
        catch { askStatus.textContent = 'Windows could not open that file.'; }
      });
      actions.append(button);
    };
    if (file.canOpen) addAction('Open file', 'open');
    addAction('Open in VS Code', 'vscode');
    addAction('Show in folder', 'reveal');
    item.append(title, details, actions);
    return item;
  }));
  if (files.length) askFiles.firstElementChild?.scrollIntoView({ block: 'nearest' });
}

const previewKeywords = new Set(('alignas async await bool boolean break case catch char class const continue def default do double else enum export extern false finally float fn for from function go if import in int interface let long match namespace new nil none null package pass private public raise return short signed static string struct switch throw true try type typedef uint union unsigned using var void while yield').split(' '));

function highlightPreview(code: HTMLElement, text: string, path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (/^(?:txt|md|csv)$/.test(extension)) { code.textContent = text; return; }
  const hash = extension === 'py' ? /#[^\r\n]*/ : /^(?:[ \t]*)#[^\r\n]*/;
  const tokens = [
    /(?<comment>\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|<!--[\s\S]*?-->)/,
    /(?<string>"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60)/,
    /(?<number>\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)/,
    /(?<word>\b[A-Za-z_]\w*\b)/,
  ].map(token => token.source);
  if (/^(?:c|h|cpp|cs|py)$/.test(extension)) tokens.unshift('(?<directive>' + hash.source + ')');
  if (extension === 'html') tokens.unshift(/(?<tag><\/?[a-z][\w-]*)/i.source);
  const pattern = new RegExp(tokens.join('|'), 'gm');
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const token = match[0];
    const group = Object.keys(match.groups ?? {}).find(name => match.groups?.[name] !== undefined);
    const color = group === 'word' ? (previewKeywords.has(token.toLowerCase()) ? 'keyword' : undefined) :
      group === 'directive' && extension === 'py' ? 'comment' : group;
    if (!color) continue;
    fragment.append(text.slice(cursor, index));
    const span = document.createElement('span');
    span.className = 'preview-' + color;
    span.textContent = token;
    fragment.append(span);
    cursor = index + token.length;
  }
  fragment.append(text.slice(cursor));
  code.replaceChildren(fragment);
}

function showProjectPreview(preview: EditPreview) {
  const heading = document.createElement('strong');
  heading.textContent = 'Review file changes';
  const path = document.createElement('p');
  path.textContent = preview.path;
  const source = (label: string, text: string, expanded: boolean) => {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    summary.textContent = label;
    highlightPreview(code, text, preview.path);
    pre.append(code);
    details.open = expanded;
    details.append(summary, pre);
    return details;
  };
  const actions = document.createElement('div');
  actions.className = 'settings-row';
  for (const [apply, label] of [[true, preview.test ? 'Apply & run npm test' : 'Apply to file'], [false, 'Discard']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (askSend.disabled) return;
      askSend.disabled = true;
      askProposal.replaceChildren();
      askStatus.textContent = apply ? 'Applying approved edit…' : '';
      try {
        const result = await api.approveProjectEdit(preview.id, apply);
        addAskTurn('assistant', result.message);
        if (result.files) showAskFiles(result.files);
        askStatus.textContent = '';
      } catch {
        askStatus.textContent = 'The project action did not finish.';
      } finally { askSend.disabled = false; }
    });
    actions.append(button);
  }
  askProposal.replaceChildren(heading, path, source('Current contents', preview.before, false),
    source('Proposed contents', preview.after, true), actions);
  askProposal.scrollIntoView({ block: 'nearest' });
}

askForm.addEventListener('submit', async event => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (!question || askSend.disabled) return;
  askSend.disabled = true;
  askFiles.replaceChildren();
  askProposal.replaceChildren();
  askInput.value = '';
  addAskTurn('user', question);
  askStatus.textContent = 'Thinking on this PC…';
  try {
    const reply = await api.askPet(askTurns, askScope.value);
    if (reply.run) {
      const { engine, fallback } = reply.run;
      askEngine.textContent = fallback ? providerNames[fallback] + ' → Qwen' :
        engine === 'qwen' ? 'LOCAL · QWEN3' : engine === 'windows' ? 'LOCAL TOOL' : providerNames[engine];
      askEngine.title = fallback ? 'Cloud provider unavailable. Retried this request with local Qwen.' : '';
    }
    askDraft.remove();
    askStatus.textContent = '';
    addAskTurn('assistant', reply.message);
    if (reply.files) showAskFiles(reply.files);
    if (reply.proposal) showProjectPreview(reply.proposal);
    if (reply.mood) {
      reactionUntil = Date.now() + 1300;
      petButton.dataset.mood = reply.mood;
    }
  } catch {
    askStatus.textContent = 'The request did not finish. Try again.';
  } finally {
    askDraft.remove();
    askSend.disabled = false;
  }
});

