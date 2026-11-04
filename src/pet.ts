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

export const fresh = (now: number, kind: Species = 'anino', name: string = species[kind].label) => ({
  kind, name,
  food: 70, energy: 76, bond: 0, nap: 0, wakeUntil: 0, updated: now,
  egg: 'locked' as 'locked' | 'found' | 'waiting' | 'done',
  dawn: 0, items: [] as string[], journal: [] as string[],
});
export type Pet = ReturnType<typeof fresh>;
export const clamp = (value: number) => Math.min(100, Math.max(0, value));
export function advance(pet: Pet, now: number) {
  const elapsed = Math.max(0, now - pet.updated);
  const hours = Math.min(6, elapsed / 3600000);
  const awake = Math.max(0, now - Math.max(pet.updated, pet.nap));
  pet.food = clamp(pet.food - hours * 4);
  pet.energy = clamp(pet.energy - Math.min(6, awake / 3600000) * 3);
  if (pet.nap && now >= pet.nap) {
    pet.energy = clamp(pet.energy + 35);
    pet.nap = 0;
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
      const rested = clamp((1 - (pet.nap - now) / napDuration) * 100) / 100;
      pet.energy = clamp(pet.energy + 35 * rested);
      pet.nap = 0;
    }
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
  if (pet.egg === 'locked' && pet.bond >= 6) {
    pet.egg = 'found';
    pet.journal.push(pet.name + ' brought home a shimmering egg.');
    return { mood: 'surprised', message: (action === 'throw' ? message + ' ' : '') + pet.name + ' found a shimmering egg!' };
  }
  return { mood, message };
}







