const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fresh, advance, act, customizePet, companionDetails } = require('../dist/pet');
const { validateRoutines, restoreRoutines, routineAt } = require('../dist/routines');
const { summarizeWeather } = require('../dist/weather');

const rule = (activity, extra = {}) => ({ id: activity, name: activity, activity, days: [0,1,2,3,4,5,6], start: '09:00', end: '17:00', enabled: true, ...extra });

test('routines validate IDs, weekdays, intervals, and saved data', () => {
  assert.equal(validateRoutines([rule('play')]).length, 1);
  assert.throws(() => validateRoutines([rule('play',{days:[]})]), /weekdays/);
  assert.throws(() => validateRoutines([rule('play',{start:'17:00'})]), /different/);
  assert.throws(() => validateRoutines([rule('play'),rule('play')]), /routine/);
  assert.throws(() => validateRoutines(Array.from({length:13},(_,id)=>rule('roam',{id:String(id)}))), /12/);
  assert.deepEqual(restoreRoutines(undefined), []);
});

test('overnight schedules follow the start weekday, with exclusive end times', () => {
  const mondaySleep = rule('sleep',{days:[1],start:'22:00',end:'07:00'});
  assert.equal(routineAt([mondaySleep],new Date(2026,10,2,22)).active.id,'sleep');
  const overnight = routineAt([mondaySleep],new Date(2026,10,3,6,59));
  assert.equal(overnight.active.id,'sleep');
  assert.equal(new Date(overnight.ends).getDate(),3);
  assert.equal(routineAt([mondaySleep],new Date(2026,10,3,7)).active,null);
  assert.equal(routineAt([mondaySleep],new Date(2026,10,4,6)).active,null);
});

test('routine overlaps prioritize quiet, sleep, play, and roam deterministically', () => {
  const now = new Date(2026,10,4,12);
  const rules = ['roam','play','sleep','quiet'].map(activity=>rule(activity));
  assert.equal(routineAt(rules,now).active.activity,'quiet');
  rules[3].enabled = false;
  assert.equal(routineAt(rules,now).active.activity,'sleep');
  rules[2].enabled = false;
  assert.equal(routineAt(rules,now).active.activity,'play');
  const original = routineAt(rules,now).occurrence;
  rules[1].end = '18:00';
  assert.notEqual(routineAt(rules,now).occurrence,original);
});

test('older pets gain persistent personality defaults and milestone rewards only once', () => {
  const now = Date.now();
  const pet = fresh(now,'dog','Biscuit');
  delete pet.personality; delete pet.activities; delete pet.habits; delete pet.accessory; delete pet.routineSleep;
  pet.bond = 65;
  advance(pet,now);
  assert.equal(pet.personality,'playful');
  assert.deepEqual(pet.activities,{feed:0,pet:0,throw:0,sleep:0});
  assert.ok(pet.items.includes('Little Crown'));
  const journalLength = pet.journal.length;
  advance(pet,now+1000);
  assert.equal(pet.journal.length,journalLength);
  customizePet(pet,'gentle','crown');
  const restored = JSON.parse(JSON.stringify(pet));
  advance(restored,now+2000);
  assert.equal(restored.accessory,'crown');
  assert.equal(restored.personality,'gentle');
  assert.equal(companionDetails(restored).tier,'Best friend');
});

test('successful care records favorites and local habits while rejected activities do not', () => {
  const now = new Date(2026,10,4,14).getTime();
  const pet = fresh(now,'cat','Mochi');
  act(pet,'pet',now);
  act(pet,'pet',now);
  act(pet,'feed',now);
  assert.equal(companionDetails(pet).favorite,'Cuddles');
  assert.match(companionDetails(pet).habit,/afternoon/);
  assert.equal(pet.habits.afternoon,3);
  assert.throws(()=>customizePet(pet,'playful','crown'),/locked/);
  assert.throws(()=>customizePet(pet,'unknown','none'),/personality/);
  act(pet,'sleep',now);
  act(pet,'throw',now+100);
  assert.equal(pet.activities.throw,0);
  assert.equal(pet.activities.sleep,1);
});

test('waking partway through scheduled sleep restores proportional rest', () => {
  const now = Date.now();
  const pet = fresh(now);
  pet.energy = 20;
  pet.nap = now+3600000;
  pet.routineSleep = {occurrence:'sleep/day',started:now,until:pet.nap};
  act(pet,'wake',now+1800000);
  assert.ok(Math.abs(pet.energy-37.5)<.01);
  assert.equal(pet.nap,0);
  assert.equal(pet.routineSleep,null);
});

test('visual weather follows current conditions even when the upcoming forecast differs', () => {
  const time = Math.floor(Date.now()/1000);
  const data = {
    current:{time,weather_code:0,temperature_2m:25,apparent_temperature:26,precipitation:0,wind_gusts_10m:10},
    hourly:{time:[time+3600],weather_code:[95],precipitation:[10],precipitation_probability:[100],wind_gusts_10m:[90],apparent_temperature:[35]},
  };
  assert.equal(summarizeWeather(data).hazard,'thunderstorm');
  assert.equal(summarizeWeather(data).scene,'clear');
  data.current.weather_code = 61;
  assert.equal(summarizeWeather(data).scene,'rain');
  data.current.weather_code = 0;
  data.current.temperature_2m = 4;
  assert.equal(summarizeWeather(data).scene,'cold');
});
