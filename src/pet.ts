export const species = {
  anino: { label: 'Anino', snack: 'moon cookie', happy: 'does a gremlin wiggle' },
  cat: { label: 'Cat', snack: 'fish treat', happy: 'purrs and swishes their tail' },
  dog: { label: 'Dog', snack: 'biscuit', happy: 'wags their tail' },
  ghost: { label: 'Boo', snack: 'moon puff', happy: 'floats in a happy little loop' },
  sprout: { label: 'Pip', snack: 'sun drop', happy: 'wiggles their leaves' },
  robot: { label: 'Byte', snack: 'energy chip', happy: 'blinks a happy signal' },
  bunny: { label: 'Mallow', snack: 'carrot coin', happy: 'flops an ear and wiggles' },
  cloud: { label: 'Nimbus', snack: 'sugar puff', happy: 'puffs up and sparkles' },
  chicken: { label: 'Chicken', snack: 'corn', happy: 'flutters their wings' },
} as const;
export type Species = keyof typeof species;
export function isSpecies(value: unknown): value is Species {
  return typeof value === 'string' && Object.hasOwn(species, value);
}

const napDuration = 15000;
export const personalityLabels = { curious: 'Curious', playful: 'Playful', gentle: 'Gentle', dreamy: 'Dreamy' } as const;
export type Personality = keyof typeof personalityLabels;
export const accessories = {
  none: { name: 'None', bond: 0, item: '' },
  ribbon: { name: 'Friendship Ribbon', bond: 10, item: 'Friendship Ribbon' },
  star: { name: 'Star Pin', bond: 30, item: 'Star Pin' },
  crown: { name: 'Little Crown', bond: 60, item: 'Little Crown' },
  halo: { name: 'Friendship Halo', bond: 90, item: 'Friendship Halo' },
} as const;
export type Accessory = keyof typeof accessories;
const personalities: Record<Species, Personality> = { anino: 'curious', cat: 'curious', dog: 'playful', chicken: 'playful', ghost: 'dreamy', sprout: 'gentle', robot: 'curious', bunny: 'gentle', cloud: 'dreamy' };
const emptyActivities = () => ({ feed: 0, pet: 0, throw: 0, sleep: 0 });
const emptyHabits = () => ({ morning: 0, afternoon: 0, evening: 0, night: 0 });

export const fresh = (now: number, kind: Species = 'anino', name: string = species[kind].label) => ({
  kind, name,
  food: 70, energy: 76, bond: 0, nap: 0, wakeUntil: 0, updated: now,
  egg: 'locked' as 'locked' | 'found' | 'waiting' | 'done',
  dawn: 0, items: [] as string[], journal: [] as string[],
  personality: personalities[kind], activities: emptyActivities(), habits: emptyHabits(), accessory: 'none' as Accessory,
  routineSleep: null as { occurrence: string; started: number; until: number } | null,
});
export type Pet = ReturnType<typeof fresh>;
export const clamp = (value: number) => Math.min(100, Math.max(0, value));
function restoreProgress(pet: Pet) {
  if (!Object.hasOwn(personalityLabels, pet.personality)) pet.personality = personalities[pet.kind] ?? 'curious';
  const activities = pet.activities, habits = pet.habits;
  pet.activities = emptyActivities();
  pet.habits = emptyHabits();
  const groups: [Record<string, number>, Record<string, number> | undefined][] = [[pet.activities, activities], [pet.habits, habits]];
  for (const [output, saved] of groups) {
    for (const key of Object.keys(output)) {
      const value = saved?.[key];
      output[key] = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
    }
  }
  if (!Object.hasOwn(accessories, pet.accessory) || (pet.accessory !== 'none' && !pet.items.includes(accessories[pet.accessory].item))) pet.accessory = 'none';
  if (!pet.routineSleep || typeof pet.routineSleep.occurrence !== 'string' || !Number.isFinite(pet.routineSleep.started) || !Number.isFinite(pet.routineSleep.until)) pet.routineSleep = null;
  unlockMilestones(pet);
}

function unlockMilestones(pet: Pet) {
  for (const reward of Object.values(accessories)) {
    if (reward.item && pet.bond >= reward.bond && !pet.items.includes(reward.item)) {
      pet.items.push(reward.item);
      pet.journal.push(pet.name + ' reached ' + reward.bond + ' friendship and unlocked a ' + reward.name + '.');
    }
  }
}

function recordActivity(pet: Pet, activity: keyof Pet['activities'], now: number) {
  pet.activities[activity] = Math.min(1000000, pet.activities[activity] + 1);
  const hour = new Date(now).getHours();
  const period = hour < 6 || hour >= 22 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  pet.habits[period] = Math.min(1000000, pet.habits[period] + 1);
  unlockMilestones(pet);
}

export function companionDetails(pet: Pet) {
  const activityNames = { feed: 'Snacks', pet: 'Cuddles', throw: 'Playing ball', sleep: 'Naps' };
  const favorites = Object.entries(pet.activities).sort((a, b) => b[1] - a[1]);
  const habits = Object.entries(pet.habits).sort((a, b) => b[1] - a[1]);
  const tier = pet.bond >= 90 ? 'Soul companion' : pet.bond >= 60 ? 'Best friend' : pet.bond >= 30 ? 'Close friend' : pet.bond >= 10 ? 'Buddy' : 'New friend';
  const next = Object.values(accessories).find(reward => reward.bond > pet.bond);
  return {
    tier, personality: personalityLabels[pet.personality],
    favorite: favorites[0][1] > 0 ? activityNames[favorites[0][0] as keyof typeof activityNames] : 'Still discovering',
    habit: habits[0][1] > 0 ? 'Usually cared for in the ' + habits[0][0] + '.' : 'Care for your pet to discover their habits.',
    next: next ? next.name + ' at ' + next.bond + ' friendship' : 'All friendship rewards unlocked',
    accessories: Object.entries(accessories).map(([id, reward]) => ({ id, name: reward.name, unlocked: !reward.item || pet.items.includes(reward.item), bond: reward.bond })),
  };
}

export function customizePet(pet: Pet, personality: unknown, accessory: unknown) {
  if (typeof personality !== 'string' || !Object.hasOwn(personalityLabels, personality)) throw new Error('Choose a valid personality.');
  if (typeof accessory !== 'string' || !Object.hasOwn(accessories, accessory)) throw new Error('Choose a valid accessory.');
  const selected = accessory as Accessory;
  if (selected !== 'none' && !pet.items.includes(accessories[selected].item)) throw new Error('That accessory is still locked.');
  pet.personality = personality as Personality;
  pet.accessory = selected;
}
export function advance(pet: Pet, now: number) {
  restoreProgress(pet);
  const elapsed = Math.max(0, now - pet.updated);
  const hours = Math.min(6, elapsed / 3600000);
  const awake = Math.max(0, now - Math.max(pet.updated, pet.nap));
  pet.food = clamp(pet.food - hours * 4);
  pet.energy = clamp(pet.energy - Math.min(6, awake / 3600000) * 3);
  if (pet.nap && now >= pet.nap) {
    pet.energy = clamp(pet.energy + 35);
    pet.nap = 0;
    pet.routineSleep = null;
  }
  if (pet.egg === 'waiting' && now >= pet.dawn) {
    pet.items.push('Dawn Shard');
    pet.journal.push('The egg left a Dawn Shard in its nest.');
    pet.egg = 'done';
  }
  pet.updated = now;
}
export function act(pet: Pet, action: string, now: number, random = Math.random) {
  advance(pet, now);
  if (action === 'wake') {
    if (pet.nap) {
      const duration = pet.routineSleep && pet.nap === pet.routineSleep.until ? pet.routineSleep.until - pet.routineSleep.started : napDuration;
      const rested = clamp((1 - (pet.nap - now) / Math.max(1, duration)) * 100) / 100;
      pet.energy = clamp(pet.energy + 35 * rested);
      pet.nap = 0;
    }
    pet.routineSleep = null;
    pet.wakeUntil = now + 5 * 60 * 1000;
    return { mood: 'stretch', message: pet.name + ' is awake.' };
  }
  if (pet.nap) return { mood: 'sleep', message: pet.name + ' is napping.' };
  let mood = 'idle';
  let message = '';
  switch (action) {
    case 'throw':
      if (pet.energy < 8) return { mood: 'sleep', message: pet.name + ' needs a nap before playing.' };
      pet.energy = clamp(pet.energy - 6);
      pet.bond = clamp(pet.bond + 2);
      mood = 'happy';
      message = pet.name + ' ' + {
        dog: 'fetches the ball and brings it back.',
        cat: 'pounces and bats the ball back.',
        chicken: 'hops back, then pecks the ball.',
        anino: 'sneaks up and makes the ball disappear.',
        ghost: 'floats over and vanishes with the ball.',
        sprout: 'waddles over and nudges the ball.',
        bunny: 'hops over and bats the ball back.',
        cloud: 'floats over and disappears in a puff with the ball.',
        robot: 'picks up the ball and delivers it back.',
      }[pet.kind];
      break;
    case 'feed':
      pet.food = clamp(pet.food + 24);
      pet.bond = clamp(pet.bond + 1);
      mood = 'eat'; message = pet.name + ' munches on a ' + species[pet.kind].snack + '.';
      break;
    case 'pet':
      pet.bond = clamp(pet.bond + 3);
      mood = 'happy'; message = pet.name + ' ' + species[pet.kind].happy + '.';
      break;
    case 'sleep':
      pet.nap = now + napDuration;
      pet.routineSleep = null;
      pet.wakeUntil = 0;
      mood = 'sleep'; message = 'A little 15-second nap.';
      break;
    case 'open':
      if (pet.egg !== 'found') break;
      pet.egg = 'done';
      mood = 'surprised';
      if (random() < 0.4) {
        pet.items.push('Moonclip');
        message = 'A rare Moonclip! ' + pet.name + ' puts it on.';
      } else {
        mood = 'smoke';
        message = 'POOF! ' + pet.name + ' gets a little fright.';
      }
      pet.journal.push(message);
      break;
    case 'wait':
      if (pet.egg !== 'found') break;
      const dawn = new Date(now);
      dawn.setHours(6, 0, 0, 0);
      if (dawn.getTime() <= now) dawn.setDate(dawn.getDate() + 1);
      pet.dawn = dawn.getTime();
      pet.egg = 'waiting';
      message = 'Tucked away until 6 AM.';
      pet.journal.push(message);
      break;
  }
  if (action === 'feed' || action === 'pet' || action === 'throw' || action === 'sleep') recordActivity(pet, action, now);
  if (pet.egg === 'locked' && pet.bond >= 6) {
    pet.egg = 'found';
    pet.journal.push(pet.name + ' brought home a shimmering egg.');
    return { mood: 'surprised', message: (action === 'throw' ? message + ' ' : '') + pet.name + ' found a shimmering egg!' };
  }
  return { mood, message };
}







