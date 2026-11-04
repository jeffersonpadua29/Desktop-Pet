export type WeatherLocation = { name: string; latitude: number; longitude: number; source: 'city' | 'ip' };
export type WeatherScene = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'cold' | 'hot' | 'wind';
export type WeatherReport = { summary: string; temperature: number; updated: number; hazard: string; advisory: string; scene: WeatherScene };
export type WeatherState = { location: WeatherLocation | null; report: WeatherReport | null; error: string; loading: boolean };

export function normalizeLocation(input: unknown): WeatherLocation | null {
  if (!input || typeof input !== 'object') return null;
  const location = input as WeatherLocation;
  if (typeof location.name !== 'string' || !location.name.trim() ||
      !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 ||
      !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180 ||
      !['city', 'ip'].includes(location.source)) return null;
  return { name: location.name.trim().slice(0, 120), latitude: location.latitude, longitude: location.longitude, source: location.source };
}

async function getJson(url: URL | string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Weather service unavailable. Try again later.');
  return response.json();
}

export async function detectLocation(): Promise<WeatherLocation> {
  const data = await getJson('https://ipwho.is/?fields=success,city,region,country,latitude,longitude');
  const location = normalizeLocation({
    name: [data.city || data.region, data.country].filter(Boolean).join(', '),
    latitude: data.latitude, longitude: data.longitude, source: 'ip',
  });
  if (!data.success || !location) throw new Error('Could not detect a location. Search for your city instead.');
  return location;
}

export async function searchLocations(query: string): Promise<WeatherLocation[]> {
  if (query.trim().length < 2 || query.length > 100) throw new Error('Enter a city name between 2 and 100 characters.');
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name: query.trim(), count: '5', language: 'en', format: 'json' }).toString();
  const data = await getJson(url);
  if (!Array.isArray(data.results)) return [];
  return data.results.map((item: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }) => normalizeLocation({
    name: [...new Set([item.name, item.admin1, item.country].filter(Boolean))].join(', '),
    latitude: item.latitude, longitude: item.longitude, source: 'city',
  })).filter((location: WeatherLocation | null): location is WeatherLocation => location !== null);
}

export function weatherDescription(code: number) {
  if (code === 0) return 'Clear skies';
  if (code <= 3) return 'Partly cloudy to overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorms';
}

type Conditions = { weather_code: number; temperature_2m: number; apparent_temperature: number; precipitation: number; wind_gusts_10m: number; time: number };
type Hourly = { time: number[]; weather_code: number[]; precipitation: number[]; precipitation_probability: number[]; wind_gusts_10m: number[]; apparent_temperature: number[] };

export function weatherScene(current: Conditions): WeatherScene {
  const code = current.weather_code;
  if (code >= 95) return 'storm';
  if ([56, 57, 66, 67, 71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ((code >= 51 && code <= 65) || (code >= 80 && code <= 82)) return 'rain';
  if (current.temperature_2m <= 10) return 'cold';
  if (current.apparent_temperature >= 35) return 'hot';
  if (current.wind_gusts_10m >= 60) return 'wind';
  return code === 0 ? 'clear' : 'cloudy';
}

export function summarizeWeather(data: { current: Conditions; hourly: Hourly }, now = Date.now()): WeatherReport {
  const current = data.current;
  if (!current || ![current.weather_code, current.temperature_2m, current.apparent_temperature, current.precipitation, current.wind_gusts_10m, current.time].every(Number.isFinite) ||
      Math.abs(now - current.time * 1000) > 3 * 3600000) throw new Error('The weather service returned incomplete or outdated conditions.');
  const hourly = data.hourly;
  const fields = ['time', 'weather_code', 'precipitation', 'precipitation_probability', 'wind_gusts_10m', 'apparent_temperature'] as const;
  if (!hourly || !fields.every(key => Array.isArray(hourly[key]))) throw new Error('The weather forecast is incomplete.');
  const upcoming = hourly.time.map((time, index) => ({ time, index })).filter(({ time }) => time * 1000 >= now && time * 1000 <= now + 3 * 3600000);
  if (!upcoming.length || !upcoming.every(({ index }) => fields.every(key => Number.isFinite(hourly[key][index])))) throw new Error('The weather forecast is incomplete.');
  const codes = [current.weather_code, ...upcoming.map(({ index }) => hourly.weather_code[index])];
  const rain = Math.max(current.precipitation, ...upcoming.map(({ index }) => hourly.precipitation[index]));
  const wind = Math.max(current.wind_gusts_10m, ...upcoming.map(({ index }) => hourly.wind_gusts_10m[index]));
  const heat = Math.max(current.apparent_temperature, ...upcoming.map(({ index }) => hourly.apparent_temperature[index]));
  const rainChance = Math.max(...upcoming.map(({ index }) => hourly.precipitation_probability[index]));
  let hazard = '', advisory = '';
  if (codes.some(code => code >= 95)) { hazard = 'thunderstorm'; advisory = 'Thunderstorms in the current or next 3-hour forecast.'; }
  else if (rain >= 7.5) { hazard = 'heavy-rain'; advisory = 'Heavy precipitation in the current or next 3-hour forecast.'; }
  else if (codes.some(code => [56, 57, 66, 67, 71, 73, 75, 77, 85, 86].includes(code))) { hazard = 'snow-ice'; advisory = 'Snow or freezing precipitation in the current or next 3-hour forecast.'; }
  else if (wind >= 60) { hazard = 'wind'; advisory = 'Forecast wind gusts reach ' + Math.round(wind) + ' km/h within 3 hours.'; }
  else if (heat >= 35) { hazard = 'heat'; advisory = 'Forecast feels-like temperature reaches ' + Math.round(heat) + ' °C within 3 hours.'; }
  else if (rain >= .2 && rainChance >= 70) { hazard = 'rain'; advisory = 'Rain is likely within 3 hours (' + Math.round(rainChance) + '% chance).'; }
  return { summary: weatherDescription(current.weather_code), temperature: current.temperature_2m, updated: now, hazard, advisory, scene: weatherScene(current) };
}

export async function fetchWeather(location: WeatherLocation): Promise<WeatherReport> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude),
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_gusts_10m',
    hourly: 'weather_code,precipitation,precipitation_probability,wind_gusts_10m,apparent_temperature',
    forecast_hours: '6', timeformat: 'unixtime', timezone: 'auto',
  }).toString();
  return summarizeWeather(await getJson(url));
}
