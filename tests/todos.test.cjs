const {test} = require('node:test');
const assert = require('node:assert/strict');
const {changeTodo,restoreTodos,pendingReminders,reminderMessage} = require('../dist/todos');

const add = (deadline=Date.now()+3600000) => ({type:'save',title:'Submit report',deadline,remindMinutes:15});

test('tasks support create, edit, complete, reopen, delete, and saved-data restoration',()=>{
  let todos=changeTodo([],add());
  const id=todos[0].id;
  todos=changeTodo(todos,{...add(todos[0].deadline),id,title:'Updated report'});
  assert.equal(todos[0].title,'Updated report');
  todos=changeTodo(todos,{type:'complete',id,completed:true});
  assert.equal(pendingReminders(todos,Date.now()+7200000).length,0);
  todos=changeTodo(todos,{type:'complete',id,completed:false});
  assert.equal(pendingReminders(todos,Date.now()+7200000).length,1);
  assert.deepEqual(restoreTodos(JSON.parse(JSON.stringify(todos))),todos);
  assert.equal(changeTodo(todos,{type:'delete',id}).length,0);
  assert.deepEqual(restoreTodos(undefined),[]);
});

test('invalid tasks and excessive task lists are rejected',()=>{
  assert.throws(()=>changeTodo([],{...add(),title:' '}),/title/);
  assert.throws(()=>changeTodo([],{...add(),deadline:NaN}),/deadline/);
  assert.throws(()=>changeTodo([],{...add(),remindMinutes:-1}),/reminder/);
  const full=Array.from({length:100},(_,i)=>({...changeTodo([],add())[0],id:'task-'+i}));
  assert.throws(()=>changeTodo(full,add()),/limit/);
});

test('advance and due reminders have separate receipt flags and suppress completed tasks',()=>{
  const now=Date.now();
  const todos=changeTodo([],add(now+3600000));
  assert.equal(pendingReminders(todos,now+44*60000).length,0);
  assert.equal(pendingReminders(todos,now+45*60000)[0].due,false);
  todos[0].reminded=true;
  assert.equal(pendingReminders(todos,now+50*60000).length,0);
  assert.equal(pendingReminders(todos,now+60*60000)[0].due,true);
  todos[0].dueNotified=true;
  assert.equal(pendingReminders(todos,now+7200000).length,0);
  assert.match(reminderMessage(todos,true),/Submit report/);
});

test('retrying a reopen or renaming a task does not repeat an already sent reminder',()=>{
  let todos=changeTodo([],add(Date.now()-1000));
  const id=todos[0].id;
  todos[0].reminded=true;todos[0].dueNotified=true;
  todos=changeTodo(todos,{type:'complete',id,completed:false});
  assert.equal(todos[0].dueNotified,true);
  todos=changeTodo(todos,{type:'save',id,title:'New title',deadline:todos[0].deadline,remindMinutes:15});
  assert.equal(todos[0].dueNotified,true);
  todos=changeTodo(todos,{type:'save',id,title:'New title',deadline:Date.now()+3600000,remindMinutes:5});
  assert.equal(todos[0].dueNotified,false);
});

