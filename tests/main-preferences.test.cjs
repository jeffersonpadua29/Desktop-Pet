const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fresh } = require('../dist/pet');

async function start(saved, weatherOverrides = {}, overrides = {}) {
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
    app: {setName:()=>{},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:name=>overrides.paths?.[name] ?? '/virtual/'+name,on:(name,fn)=>{events[name]=fn;},quit:()=>{}},
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
    require:name=>overrides.modules?.[name]
      ? { ...mocks[name], ...overrides.modules[name] }
      : mocks[name] || require(name.startsWith('.') ? path.join(__dirname,'../dist',name) : name),
    exports:{},__dirname:path.join(__dirname,'../dist'),process:{arch:'x64'},console,Buffer,
    setInterval:fn=>{intervals.push(fn);return {fn};},clearInterval:()=>{},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/main.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {call:(name,...args)=>ipc[name]({},...args),window,files,alerts,menu:()=>menu,area,location,
    tickReminders:()=>intervals.find(fn=>fn.name==='checkTodoReminders')(),
    desktopAlert:input=>{windowsAlert=input;intervals.find(fn=>fn.name==='pollWindowsAlerts')();}};
}

test('Settings encrypts the selected provider key and cloud failure falls back in Ask', async t => {
  const saved = { pets: { cat: fresh(Date.now(), 'cat', 'Mochi') }, active: 'cat' };
  let settings = '';
  let encrypted = '';
  let attempted = 0;
  const key = 'private-fixture-api-key';
  const app = await start(saved, {}, {
    modules: {
      electron: { safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => { encrypted = value; return Buffer.from('ciphertext'); },
        decryptString: value => { assert.equal(value.toString(), 'ciphertext'); return encrypted; },
      } },
      'node:fs': {
        readFileSync: name => name.endsWith('ai-settings.json') ? settings : JSON.stringify(saved),
        writeFileSync: (name, value) => { if (name.endsWith('ai-settings.json.tmp')) settings = value; },
        renameSync: () => {},
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.openai.com/')) {
      attempted++;
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      return new Response('', { status: 401 });
    }
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    return Response.json({ message: { content: 'Local fallback answer.' } });
  });
  const input = { enabled: true, provider: 'openai', model: 'gpt-4.1-mini', key };
  assert.equal(app.call('ai-settings').enabled, false);
  assert.equal(app.call('save-ai-settings', input).hasKey, true);
  assert.doesNotMatch(settings, new RegExp(key));
  assert.equal(app.call('ai-settings').secret, undefined);
  const reply = await app.call('ask-pet', [{ role: 'user', content: 'Explain arrays' }], 'all');
  assert.equal(reply.message, 'Local fallback answer.');
  assert.equal(reply.run.engine, 'qwen');
  assert.equal(reply.run.fallback, 'openai');
  const removed = app.call('save-ai-settings', { ...input, key: '' }, true);
  assert.equal(removed.hasKey, false);
  assert.equal(removed.enabled, false);
  await app.call('ask-pet', [{ role: 'user', content: 'Explain arrays' }], 'all');
  assert.equal(attempted, 1);
});

test('Ask Pet uses cloud code to edit the last created file on disk after approval', async t => {
  const folder = fs.mkdtempSync(path.join(__dirname, '..', '.pet-pocket-edit-'));
  const filename = path.join(folder, 'sort.c');
  t.after(() => {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(folder);
  });
  const oldCode = 'int count(void) { return 1; }\n';
  const newCode = 'int count(void) { return 2; }\n';
  const home = { pets: { cat: fresh(Date.now(), 'cat', 'Mochi') }, active: 'cat' };
  let approvedCloudShare = false;
  const app = await start(home, {}, {
    paths: { downloads: folder },
    modules: {
      electron: {
        safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'fixture-key' },
        dialog: {
          showOpenDialog: () => assert.fail('A known file does not need a folder picker.'),
          showMessageBox: async (_window, options) => {
            assert.match(options.detail, /sort\.c/);
            approvedCloudShare = true;
            return { response: 1 };
          },
        },
      },
      'node:fs': {
        readFileSync: name => JSON.stringify(name.endsWith('ai-settings.json')
          ? { enabled: true, provider: 'openai', model: 'gpt-4.1-mini', secret: 'Y2lwaGVydGV4dA==' }
          : home),
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/api\.openai\.com/);
    const body = JSON.parse(options.body);
    const name = body.tools[0].function.name;
    let args = { name: 'sort.c', content: oldCode };
    if (name === 'propose_source') {
      assert.equal(approvedCloudShare, true);
      const request = JSON.parse(body.messages.at(-1).content);
      assert.equal(request.filename, 'sort.c');
      assert.equal(request.source, oldCode);
      args = { content: newCode };
    }
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
  });
  const ask = content => app.call('ask-pet', [{ role: 'user', content }], 'all');
  assert.match((await ask('Create sort.c in Downloads with a function that returns 1')).message, /Saved/);
  const preview = await ask('Change the contents of that file so the function returns 2');
  assert.equal(preview.run.engine, 'openai');
  assert.equal(preview.proposal.before, oldCode);
  assert.equal(preview.proposal.after, newCode);
  assert.equal(fs.readFileSync(filename, 'utf8'), oldCode);
  const result = await ask('apply the edit');
  assert.match(result.message, /Updated “sort.c” on disk/);
  assert.equal(result.files[0].name, 'sort.c');
  assert.equal(fs.readFileSync(filename, 'utf8'), newCode);
});

test('Ask Pet renames a file across turns in either order and preserves occupied names', { skip: process.platform !== 'win32' }, async t => {
  const folder = fs.mkdtempSync(path.join(__dirname, '..', '.pet-pocket-rename-'));
  const sample = path.join(folder, 'sample.c');
  const second = path.join(folder, 'sampleTwo.c');
  const third = path.join(folder, 'sampleThree.c');
  const occupied = path.join(folder, 'occupied.c');
  t.after(() => {
    for (const file of [sample, second, third, occupied]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  });
  fs.writeFileSync(sample, 'int original;');
  fs.writeFileSync(occupied, 'int occupied;');
  const app = await start({ pets: { cat: fresh(Date.now(), 'cat', 'Mochi') }, active: 'cat' }, {}, {
    paths: { downloads: folder },
    modules: { 'node:fs': { readdirSync: fs.readdirSync, statSync: fs.statSync, existsSync: fs.existsSync } },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Renaming should stay local.'));
  const ask = content => app.call('ask-pet', [{ role: 'user', content }], 'all');
  assert.match((await ask('i said rename the file into sampleTwo.c')).message, /current filename/);
  assert.match((await ask('sample.c in download folder')).message, /Renamed “sample.c” to “sampleTwo.c”/);
  assert.equal(fs.existsSync(sample), false);
  assert.equal(fs.readFileSync(second, 'utf8'), 'int original;');
  assert.match((await ask('sampleTwo.c in download folder')).message, /Found “sampleTwo.c”/);
  assert.match((await ask('rename into occupied.c')).message, /already exists/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'int occupied;');
  assert.equal(fs.readFileSync(second, 'utf8'), 'int original;');
  const renamed = await ask('rename into sampleThree.c');
  assert.equal(renamed.files[0].name, 'sampleThree.c');
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.readFileSync(third, 'utf8'), 'int original;');
  assert.equal(fetch.mock.callCount(), 0);
});

test('Ask Pet controls only Spotify and reports the verified playback result', async t => {
  const playback = [];
  const opened = [];
  let status = 'playing';
  let selection = 'no-match';
  let verification = 'playing';
  const app = await start({ pets: { cat: fresh(Date.now(), 'cat', 'Mochi') }, active: 'cat' }, {}, {
    modules: {
      electron: { shell: { openExternal: async url => opened.push(url) } },
      'node:child_process': { execFile: (_exe, args, _options, callback) => {
        const encoded = args.indexOf('-EncodedQuery');
        const query = encoded < 0 ? null : Buffer.from(args[encoded + 1], 'base64').toString();
        const file = args[args.indexOf('-File') + 1];
        if (/spotify-search-play\.ps1$/.test(file)) {
          playback.push(['select', query]);
          return callback(null, selection + '\n');
        }
        assert.match(file, /media\.ps1$/);
        const action = args[args.indexOf('-Action') + 1];
        playback.push([action, query]);
        callback(null, (action === 'verify' ? verification : status) + '\n');
      } },
    },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Media controls are local.'));
  const ask = content => app.call('ask-pet', [{ role: 'user', content }], 'all');
  assert.equal((await ask('Play Spotify')).message, 'Spotify is playing.');
  status = 'paused';
  assert.equal((await ask('Stop Spotify')).message, 'Spotify is paused.');
  assert.equal((await ask('Press Space in Spotify')).message, 'Spotify is paused.');
  status = 'different-track';
  assert.match((await ask('search for amatz')).message, /Searching Spotify/);
  selection = JSON.stringify({ title: 'Amatz', artist: '' });
  assert.equal((await ask('now play')).message, 'Spotify is playing “Amatz”.');
  selection = JSON.stringify({ title: 'Bohemian Rhapsody', artist: 'Queen' });
  assert.equal((await ask('search for bohemian and play')).message, 'Spotify is playing “Bohemian Rhapsody” by Queen.');
  selection = 'no-match';
  assert.match((await ask('Play MATIKAS on Spotify')).message, /couldn’t find a playable result/);
  selection = JSON.stringify({ title: 'MATIKAS', artist: '' });
  verification = 'unconfirmed';
  assert.match((await ask('Play it')).message, /couldn’t confirm/);
  assert.deepEqual(playback, [
    ['play', null], ['pause', null], ['toggle', null], ['play', 'amatz'], ['select', 'amatz'], ['verify', 'Amatz'],
    ['play', 'bohemian'], ['select', 'bohemian'], ['verify', 'Bohemian Rhapsody by Queen'],
    ['play', 'MATIKAS'], ['select', 'MATIKAS'], ['play', 'MATIKAS'], ['select', 'MATIKAS'], ['verify', 'MATIKAS'],
  ]);
  assert.deepEqual(opened, ['spotify:search:amatz', 'spotify:search:bohemian', 'spotify:search:MATIKAS']);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Ask Pet opens its last generated file in VS Code and keeps the file card available', async t => {
  const assistant = require('../dist/assistant');
  const documents = path.join(path.sep, 'virtual', 'documents');
  const folder = path.join(documents, 'Pet Pocket');
  const file = { name: 'sort.c', folder, path: path.join(folder, 'sort.c'), modified: 1, canOpen: false };
  const downloads = path.join(path.sep, 'virtual', 'downloads');
  const downloadFile = path.join(downloads, 'indexsort.c');
  const otherName = 'main #1.c';
  const otherFile = path.join(documents, otherName);
  const launches = [];
  const saves = [];
  let rejectLaunch = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    message: { tool_calls: [{ function: { name: 'create_file', arguments: { name: file.name, content: 'int x;' } } }] },
  }));
  const app = await start({ pets: { cat: fresh(Date.now(), 'cat', 'Mochi') }, active: 'cat' }, {}, {
    modules: {
      './assistant': {
        ...assistant,
        findFiles: async roots => {
          assert.deepEqual(Array.from(roots), ['/virtual/downloads']);
          return { files: [{ ...file, name: 'indexsort.c', path: downloadFile, folder: downloads }], limited: false };
        },
        saveGeneratedFile: async (destination, requested) => {
          saves.push([destination, requested.name, requested.content]);
          return { ...file, name: requested.name, folder: destination, path: path.join(destination, requested.name) };
        },
      },
      'node:fs': {
        existsSync: target => [documents, folder, file.path].includes(path.normalize(target)),
        readdirSync: target => [{ name: path.normalize(target) === documents ? otherName : file.name, isFile: () => true }],
        statSync: target => [file.path, otherFile, downloadFile].includes(target) ? { isFile: () => true } : undefined,
      },
      electron: {
        shell: { openExternal: async url => {
          if (rejectLaunch) throw new Error('No Windows handler');
          launches.push(url);
        } },
      },
    },
  });
  const ask = content => app.call('ask-pet', [{ role: 'user', content }], 'all');
  assert.match((await ask('open sort.c in my document folder using vscode')).message, /Sent “sort.c” to VS Code/);
  assert.match((await ask('open "main #1.c" in Documents with VS Code')).message, /Sent “main #1.c” to VS Code/);
  assert.match((await ask('Generate sort.c with bubble sort logic')).message, /Saved “sort.c”/);
  const opened = await ask('can you open that in vscode');
  assert.match(opened.message, /Sent “sort.c” to VS Code/);
  assert.equal(opened.files[0].name, 'sort.c');
  assert.equal(await app.call('assistant-file', 0, 'vscode'), '');
  const sortUrl = 'vscode://file' + pathToFileURL(file.path).pathname;
  assert.deepEqual(launches, [sortUrl, 'vscode://file' + pathToFileURL(otherFile).pathname, sortUrl, sortUrl]);
  assert.match(launches[1], /\/main%20%231\.c$/);
  rejectLaunch = true;
  assert.match((await ask('open sort.c in vscode')).message, /couldn’t send this file to VS Code/);
  rejectLaunch = false;
  const downloaded = await ask('Can you create indexsort.c in my download folder, then open it in VS Code?');
  assert.equal(downloaded.message, 'Created an empty file named “indexsort.c” in Downloads. Sent it to VS Code.');
  assert.equal(launches.at(-1), 'vscode://file' + pathToFileURL(downloadFile).pathname);
  assert.equal((await ask('Paki hanapin ang indexsort.c sa Downloads.')).files[0].name, 'indexsort.c');
  assert.deepEqual(saves.map(([destination, name, content]) => [path.normalize(destination), name, content]), [
    [folder, 'sort.c', 'int x;'],
    [downloads, 'indexsort.c', ''],
  ]);
  assert.equal(fetch.mock.callCount(), 1);
});

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

