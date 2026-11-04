const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { fresh } = require('../dist/pet');

async function start(saved, weatherOverrides = {}) {
  const ipc = {}, events = {}, files = {}, alerts = [], intervals = [];
  let windowsAlert;
  let window, menu;
  const area = {x:0,y:0,width:1200,height:800};
  class Window {
    constructor(options) {
      window = this;
      this.bounds = {x:options.x,y:options.y,width:options.width,height:options.height};
      this.visible = true;
      this.webContents = { on:()=>{}, send:(channel, data)=>alerts.push({channel,data}) };
    }
    getBounds() { return {...this.bounds}; }
    setBounds(bounds) { this.bounds = {...this.bounds,...bounds}; }
    setPosition(x,y) { this.setBounds({x,y}); }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    setIgnoreMouseEvents() {}
    setResizable() {}
    isMaximized() { return false; }
    on() {}
    once() {}
    loadFile() { return Promise.resolve(); }
  }
  const location = {name:'Test City',latitude:1,longitude:2,source:'city'};
  const electron = {
    app: {setName:()=>{},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:name=>'/virtual/'+name,on:(name,fn)=>{events[name]=fn;},quit:()=>{}},
    BrowserWindow:Window, ipcMain:{handle:(name,fn)=>{ipc[name]=fn;},on:(name,fn)=>{ipc[name]=fn;}},
    screen:{getCursorScreenPoint:()=>({x:1000,y:700}),getDisplayNearestPoint:()=>({workArea:area}),getDisplayMatching:()=>({workArea:area})},
    Tray:class {setToolTip(){} on(){} setContextMenu(value){menu=value;}},
    Menu:{buildFromTemplate:items=>items},nativeImage:{createFromPath:()=>null},dialog:{},shell:{},
  };
  const mocks = {
    electron,
    'node:fs':{existsSync:()=>false,readdirSync:()=>windowsAlert ? ['PetPocket.NotificationListener_mock'] : [],readFileSync:name=>JSON.stringify(name.endsWith('pet-alert.json') ? windowsAlert : saved),writeFileSync:(name,data)=>{files[name]=data;},renameSync:(from,to)=>{files[to]=files[from];}},
    'node:child_process':{spawn:()=>({on:()=>{},stdout:{},stderr:{on:()=>{}},kill:()=>{}})},
    'node:readline':{createInterface:()=>({on:()=>{}})},
    './weather':{...require('../dist/weather'),detectLocation:async()=>location,searchLocations:async()=>[location],fetchWeather:async()=>({summary:'Rain',temperature:25,updated:Date.now(),hazard:'rain',advisory:'Rain soon.'}),...weatherOverrides},
  };
  const context = vm.createContext({
    require:name=>mocks[name] || require(name.startsWith('.') ? path.join(__dirname,'../dist',name) : name),
    exports:{},__dirname:path.join(__dirname,'../dist'),process:{arch:'x64'},console,
    setInterval:fn=>{intervals.push(fn);return {fn};},clearInterval:()=>{},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/main.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {call:(name,...args)=>ipc[name]({},...args),window,files,alerts,menu:()=>menu,area,location,
    tickReminders:()=>intervals.find(fn=>fn.name==='checkTodoReminders')(),
    desktopAlert:input=>{windowsAlert=input;intervals.find(fn=>fn.name==='pollWindowsAlerts')();}};
}

test('preferences and drag position persist through restart, with native position lock', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  assert.equal(app.call('status').preferences.size,'medium');
  app.call('preferences',{size:'small',locked:true,roamFrequency:'off'});
  const before = app.window.getBounds();
  app.call('drag','start');
  app.call('drag','move');
  assert.deepEqual(app.window.getBounds(),before);
  app.call('preferences',{locked:false});
  app.call('drag','start');
  app.window.setPosition(100,150);
  app.call('drag','end');
  const saved = JSON.parse(app.files[path.join('/virtual/userData','pet.json')]);
  assert.deepEqual(saved.position,{x:100,y:150});
  const restarted = await start(saved);
  assert.equal(restarted.call('status').preferences.size,'small');
  assert.equal(restarted.window.bounds.x,100);
  assert.equal(restarted.window.bounds.y,150);
  restarted.area.height = 400;
  restarted.call('return-to-screen');
  assert.ok(restarted.window.bounds.y + restarted.window.bounds.height <= 400);
  assert.ok(restarted.menu().some(item=>item.label==='Return pet to screen'));
});

test('weather preferences mute popups, deduplicate alerts, and retain the selected location', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('preferences',{alertPopups:false});
  await app.call('weather-location',app.location);
  const alerts = app.alerts.filter(alert=>alert.channel==='pet-alert');
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].data.silent,true);
  assert.equal(alerts[0].data.source,'Weather');
  await app.call('weather-refresh');
  assert.equal(app.alerts.filter(alert=>alert.channel==='pet-alert').length,1);
  const saved = JSON.parse(app.files[path.join('/virtual/userData','pet.json')]);
  assert.equal(saved.weatherLocation.name,'Test City');
  app.call('preferences',{weatherAlerts:false});
  await app.call('weather-location',{...app.location,latitude:3});
  assert.equal(app.alerts.filter(alert=>alert.channel==='pet-alert').length,1);
  await app.call('weather-location',null);
  assert.equal(app.call('status').weather.report,null);
});

test('a failed weather request exposes an error without replacing the location', async () => {
  const app = await start({pets:{},active:null},{fetchWeather:async()=>{throw Error('offline');}});
  await app.call('weather-location',app.location);
  const weather = app.call('status').weather;
  assert.match(weather.error,/unavailable/);
  assert.equal(weather.loading,false);
  assert.equal(weather.location.name,'Test City');
});

test('desktop source settings and quiet hours apply to received notifications', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('preferences',{desktopAlerts:false});
  app.desktopAlert({id:'disabled',source:'Mail',message:'Private preview',created:Date.now()});
  assert.equal(app.alerts.length,0);
  const hour = new Date().getHours();
  const time = value => String((value+24)%24).padStart(2,'0')+':00';
  app.call('preferences',{desktopAlerts:true,alertPreviews:false,quietHours:true,quietStart:time(hour-1),quietEnd:time(hour+1)});
  assert.equal(app.call('status').quietHoursActive,true);
  app.desktopAlert({id:'muted',source:'Mail',message:'Private preview',created:Date.now()});
  assert.equal(app.alerts.length,1);
  assert.equal(app.alerts[0].data.message,'');
  assert.equal(app.alerts[0].data.silent,true);
});

test('switching location while a forecast is pending ignores the earlier response', async () => {
  let resolveFirst;
  const first = new Promise(resolve=>{resolveFirst=resolve;});
  const report = {summary:'Clear',temperature:25,updated:Date.now(),hazard:'',advisory:''};
  const app = await start({pets:{},active:null},{fetchWeather:location=>location.latitude===1 ? first : Promise.resolve({...report,temperature:30})});
  const pending = app.call('weather-location',app.location);
  await new Promise(resolve=>setImmediate(resolve));
  const replacement = app.call('weather-location',{...app.location,name:'Second City',latitude:5});
  resolveFirst(report);
  await Promise.all([pending,replacement]);
  assert.equal(app.call('status').weather.location.name,'Second City');
  assert.equal(app.call('status').weather.report.temperature,30);
});

function currentRoutine(activity) {
  const hour = new Date().getHours();
  const time = value => String((value+24)%24).padStart(2,'0')+':00';
  return {id:'daily',name:'Daily routine',activity,days:[0,1,2,3,4,5,6],start:time(hour-1),end:time(hour+1),enabled:true};
}

test('routine play is applied once across repeated refreshes and restarts', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('routines',[currentRoutine('play')]);
  assert.equal(app.call('status').pet.activities.throw,1);
  assert.equal(app.call('status').pet.activities.throw,1);
  const saved = JSON.parse(app.files[path.join('/virtual/userData','pet.json')]);
  const restarted = await start(saved);
  assert.equal(restarted.call('status').pet.activities.throw,1);
  assert.equal(restarted.call('status').routine.active.activity,'play');
});

test('scheduled sleep respects manual wake and ends when its routine is deleted', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('routines',[currentRoutine('sleep')]);
  assert.ok(app.call('status').pet.nap>Date.now()+60000);
  app.call('act','wake');
  assert.equal(app.call('status').pet.nap,0);
  const another = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat',routines:[currentRoutine('sleep')]});
  another.call('routines',[]);
  assert.equal(another.call('status').pet.nap,0);
  assert.equal(another.call('status').pet.routineSleep,null);
});

test('scheduled quiet suppresses roaming and alert bubbles', async () => {
  const app = await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat',routines:[currentRoutine('quiet')]});
  assert.equal(app.call('status').quietHoursActive,true);
  assert.equal(app.call('roam',true),null);
  app.desktopAlert({id:'routine-quiet',source:'Mail',message:'Quiet routine',created:Date.now()});
  assert.equal(app.alerts.find(alert=>alert.channel==='pet-alert').data.silent,true);
});

test('customized personalities and unlocked accessories survive saving', async () => {
  const pet = fresh(Date.now(),'cat','Mochi');
  pet.bond = 35;
  const app = await start({pets:{cat:pet},active:'cat'});
  app.call('customize-pet',{personality:'dreamy',accessory:'star'});
  const saved = JSON.parse(app.files[path.join('/virtual/userData','pet.json')]);
  const restarted = await start(saved);
  assert.equal(restarted.call('status').pet.accessory,'star');
  assert.equal(restarted.call('status').companion.personality,'Dreamy');
  assert.throws(()=>restarted.call('customize-pet',{personality:'curious',accessory:'crown'}),/locked/);
});

test('deadline reminders wait for the renderer and do not repeat after restart',async()=>{
  const app=await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('todo',{type:'save',title:'Submit assignment',deadline:Date.now()-1000,remindMinutes:15});
  assert.equal(app.alerts.length,0);
  app.call('renderer-ready');
  const alert=app.alerts.find(value=>value.channel==='pet-alert');
  assert.equal(alert.data.kind,'reminder');
  assert.match(alert.data.message,/Submit assignment/);
  assert.equal(app.call('status').todos[0].dueNotified,true);
  app.tickReminders();assert.equal(app.alerts.length,1);
  const saved=JSON.parse(app.files[path.join('/virtual/userData','pet.json')]);
  const restarted=await start(saved);restarted.call('renderer-ready');
  assert.equal(restarted.alerts.length,0);
});

test('quiet periods defer task notifications and reminders have an independent toggle',async()=>{
  const app=await start({pets:{cat:fresh(Date.now(),'cat','Mochi')},active:'cat'});
  app.call('renderer-ready');
  const quiet={...currentRoutine('quiet'),id:'quiet'};
  app.call('routines',[quiet]);
  app.call('todo',{type:'save',title:'Quiet task',deadline:Date.now()-1000,remindMinutes:0});
  assert.equal(app.call('status').todos[0].dueNotified,false);
  app.call('preferences',{desktopAlerts:false,todoReminders:false});
  app.call('routines',[]);app.tickReminders();
  assert.equal(app.alerts.filter(value=>value.channel==='pet-alert').length,0);
  app.call('preferences',{todoReminders:true});app.tickReminders();
  assert.equal(app.alerts.find(value=>value.channel==='pet-alert').data.silent,false);
  assert.equal(app.call('status').todos[0].dueNotified,true);
});

