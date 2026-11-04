export const defaultPreferences = {
  locked: false,
  roamFrequency: 'normal' as 'off' | 'rarely' | 'normal' | 'often',
  size: 'medium' as 'small' | 'medium' | 'large',
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  desktopAlerts: true,
  weatherAlerts: true,
  alertPopups: true,
  alertPreviews: true,
  weatherReactions: true,
  todoReminders: true,
};
export type Preferences = typeof defaultPreferences;

export function normalizePreferences(input: unknown): Preferences {
  const output = { ...defaultPreferences };
  if (!input || typeof input !== 'object') return output;
  const saved = input as Record<string, unknown>;
  for (const key of ['locked', 'quietHours', 'desktopAlerts', 'weatherAlerts', 'alertPopups', 'alertPreviews', 'weatherReactions', 'todoReminders'] as const) {
    if (typeof saved[key] === 'boolean') output[key] = saved[key];
  }
  if (['off', 'rarely', 'normal', 'often'].includes(String(saved.roamFrequency))) output.roamFrequency = saved.roamFrequency as Preferences['roamFrequency'];
  if (['small', 'medium', 'large'].includes(String(saved.size))) output.size = saved.size as Preferences['size'];
  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (typeof saved[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(saved[key])) output[key] = saved[key];
  }
  return output;
}

export function isQuietTime(preferences: Preferences, now = new Date()) {
  if (!preferences.quietHours || preferences.quietStart === preferences.quietEnd) return false;
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  if (preferences.quietStart < preferences.quietEnd) return time >= preferences.quietStart && time < preferences.quietEnd;
  return time >= preferences.quietStart || time < preferences.quietEnd;
}
