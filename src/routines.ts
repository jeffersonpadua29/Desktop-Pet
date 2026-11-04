export type Routine = {
  id: string;
  name: string;
  activity: 'roam' | 'sleep' | 'play' | 'quiet';
  days: number[];
  start: string;
  end: string;
  enabled: boolean;
};
export type RoutineState = { active: Routine | null; occurrence: string; ends: number };

export function validateRoutines(input: unknown): Routine[] {
  if (!Array.isArray(input) || input.length > 12) throw new Error('You can save up to 12 routines.');
  const ids = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid routine.');
    const item = value as Routine;
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) || ids.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 40 ||
        !['roam', 'sleep', 'play', 'quiet'].includes(item.activity) || typeof item.enabled !== 'boolean' ||
        typeof item.start !== 'string' || typeof item.end !== 'string' || !clock.test(item.start) || !clock.test(item.end) || item.start === item.end ||
        !Array.isArray(item.days) || !item.days.length || item.days.length > 7 || !item.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
      throw new Error('Each routine needs a name, activity, weekdays, and different start and end times.');
    }
    ids.add(item.id);
    return { id: item.id, name: item.name.trim(), activity: item.activity, days: [...new Set(item.days)].sort(), start: item.start, end: item.end, enabled: item.enabled };
  });
}

export function restoreRoutines(input: unknown): Routine[] {
  try { return validateRoutines(input); } catch { return []; }
}

export function routineAt(routines: Routine[], now = new Date()): RoutineState {
  const priority = { quiet: 4, sleep: 3, play: 2, roam: 1 };
  let result: RoutineState = { active: null, occurrence: '', ends: 0 };
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  for (const routine of routines) {
    if (!routine.enabled) continue;
    const start = new Date(now);
    if (routine.start > routine.end && time < routine.end) start.setDate(start.getDate() - 1);
    if (!routine.days.includes(start.getDay())) continue;
    const [startHour, startMinute] = routine.start.split(':').map(Number);
    start.setHours(startHour, startMinute, 0, 0);
    const end = new Date(start);
    const [endHour, endMinute] = routine.end.split(':').map(Number);
    if (routine.start > routine.end) end.setDate(end.getDate() + 1);
    end.setHours(endHour, endMinute, 0, 0);
    if (now.getTime() < start.getTime() || now.getTime() >= end.getTime() || (result.active && priority[result.active.activity] >= priority[routine.activity])) continue;
    result = {
      active: routine,
      occurrence: [routine.id, start.getFullYear(), start.getMonth() + 1, start.getDate(), routine.activity, routine.start, routine.end].join('/'),
      ends: end.getTime(),
    };
  }
  return result;
}
