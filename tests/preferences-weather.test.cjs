const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultPreferences, normalizePreferences, isQuietTime } = require('../dist/settings.js');
const { normalizeLocation, summarizeWeather, searchLocations, detectLocation, fetchWeather } = require('../dist/weather.js');

test('old saves receive defaults and invalid preference values are ignored', () => {
  assert.deepEqual(normalizePreferences(undefined), defaultPreferences);
  const preferences = normalizePreferences({ locked: true, size: 'large', roamFrequency: 'off', quietStart: '25:00', desktopAlerts: 'false' });
  assert.equal(preferences.locked, true);
  assert.equal(preferences.size, 'large');
  assert.equal(preferences.roamFrequency, 'off');
  assert.equal(preferences.quietStart, '22:00');
  assert.equal(preferences.desktopAlerts, true);
  assert.deepEqual(normalizePreferences(JSON.parse(JSON.stringify(preferences))), preferences);
});

test('quiet hours cover midnight, daytime boundaries, and equal times', () => {
  const preferences = { ...defaultPreferences, quietHours: true };
  const at = (hour, minute = 0) => new Date(2026, 10, 4, hour, minute);
  assert.equal(isQuietTime(preferences, at(22)), true);
  assert.equal(isQuietTime(preferences, at(0)), true);
  assert.equal(isQuietTime(preferences, at(6, 59)), true);
  assert.equal(isQuietTime(preferences, at(7)), false);
  assert.equal(isQuietTime(preferences, at(12)), false);
  assert.equal(isQuietTime({ ...preferences, quietStart: '09:00', quietEnd: '17:00' }, at(12)), true);
  assert.equal(isQuietTime({ ...preferences, quietStart: '07:00' }, at(0)), false);
});

test('saved menu sizes reject non-numbers and clamp to usable limits', () => {
  assert.equal(normalizePreferences({ panelWidth: '600', panelHeight: Infinity }).panelWidth, 334);
  assert.equal(normalizePreferences({ panelHeight: Infinity }).panelHeight, 426);
  const limits = normalizePreferences({ panelWidth: 10000, panelHeight: -100 });
  assert.equal(limits.panelWidth, 960);
  assert.equal(limits.panelHeight, 240);
});

test('locations validate coordinates, including zero and negative coordinates', () => {
  assert.equal(normalizeLocation({ name: 'City', latitude: 91, longitude: 0, source: 'city' }), null);
  assert.equal(normalizeLocation({ name: 'City', latitude: '0', longitude: 0, source: 'ip' }), null);
  assert.equal(normalizeLocation({ name: 'City', latitude: 0, longitude: -20, source: 'ip' }).latitude, 0);
});

function forecast() {
  const time = Math.floor(Date.now() / 1000);
  return {
    current: { time, weather_code: 0, temperature_2m: 25, apparent_temperature: 26, precipitation: 0, wind_gusts_10m: 10 },
    hourly: { time: [time + 3600, time + 7200, time + 10800, time + 14400], weather_code: [0, 0, 0, 95], precipitation: [0, 0, 0, 10], precipitation_probability: [0, 0, 0, 100], wind_gusts_10m: [10, 10, 10, 100], apparent_temperature: [26, 26, 26, 45] },
  };
}

test('forecast advisories consider only the next three hours', () => {
  const data = forecast();
  assert.equal(summarizeWeather(data).hazard, '');
  data.hourly.weather_code[0] = 95;
  assert.equal(summarizeWeather(data).hazard, 'thunderstorm');
  data.hourly.weather_code[0] = 0;
  data.hourly.precipitation[1] = 8;
  assert.equal(summarizeWeather(data).hazard, 'heavy-rain');
  data.hourly.precipitation[1] = 1;
  data.hourly.precipitation_probability[1] = 80;
  assert.equal(summarizeWeather(data).hazard, 'rain');
  data.hourly.wind_gusts_10m[0] = 70;
  assert.equal(summarizeWeather(data).hazard, 'wind');
});

test('incomplete, null, and stale weather cannot produce misleading reports', () => {
  const data = forecast();
  data.current.temperature_2m = null;
  assert.throws(() => summarizeWeather(data), /incomplete/);
  data.current.temperature_2m = 25;
  data.current.time -= 4 * 3600;
  assert.throws(() => summarizeWeather(data), /outdated/);
  const partial = forecast();
  partial.hourly.precipitation = [];
  assert.throws(() => summarizeWeather(partial), /incomplete/);
});

test('API requests use HTTPS, encoded city names, and only required IP fields', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    if (String(url).includes('geocoding')) return { ok: true, json: async () => ({ results: [{ name: 'City', country: 'Country', latitude: 0, longitude: 0 }] }) };
    if (String(url).includes('ipwho')) return { ok: true, json: async () => ({ success: true, city: 'City', country: 'Country', latitude: 0, longitude: 0 }) };
    return { ok: true, json: async () => forecast() };
  };
  try {
    const matches = await searchLocations('City & Country');
    assert.equal(matches.length, 1);
    assert.equal(new URL(urls[0]).searchParams.get('name'), 'City & Country');
    const location = await detectLocation();
    assert.equal(location.source, 'ip');
    assert.ok(!new URL(urls[1]).searchParams.get('fields').split(',').includes('ip'));
    assert.equal((await fetchWeather(location)).summary, 'Clear skies');
    assert.ok(urls.every(url => url.startsWith('https://')));
    global.fetch = async () => ({ ok: false });
    await assert.rejects(fetchWeather(location), /unavailable/);
  } finally { global.fetch = originalFetch; }
});
