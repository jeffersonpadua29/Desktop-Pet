type TaskItem = import('./todos').Todo;
let taskItems: TaskItem[] = [];
let renderedTasks = '';
let editingTaskId: string | null = null;
let taskBusy = false;
const taskEditor = document.querySelector<HTMLFormElement>('#todo-editor')!;

function configureTodos(items: TaskItem[]) {
  taskItems = items;
  renderTodos();
}

function renderTodos() {
  const filter = document.querySelector<HTMLSelectElement>('#todo-filter')!.value;
  const serialized = JSON.stringify(taskItems) + filter + Math.floor(Date.now() / 60000);
  if (serialized === renderedTasks) return;
  renderedTasks = serialized;
  const visible = taskItems.filter(item => filter === 'all' || (filter === 'completed' ? item.completed : !item.completed))
    .sort((a, b) => Number(a.completed) - Number(b.completed) || a.deadline - b.deadline);
  document.querySelector<HTMLElement>('#todo-empty')!.hidden = visible.length > 0;
  document.querySelector('#todo-empty')!.textContent = taskItems.length ? 'No tasks in this view.' : 'No tasks yet.';
  document.querySelector('#todo-list')!.replaceChildren(...visible.map(item => {
    const row = document.createElement('li');
    row.className = item.completed ? 'task-completed' : item.deadline <= Date.now() ? 'task-overdue' : '';
    const title = document.createElement('strong'); title.textContent = item.title;
    const deadline = document.createElement('time');
    deadline.dateTime = new Date(item.deadline).toISOString();
    deadline.textContent = (item.completed ? 'Completed · ' : item.deadline <= Date.now() ? 'Overdue · ' : 'Due · ') + new Date(item.deadline).toLocaleString();
    const reminder = document.createElement('p'); reminder.textContent = item.remindMinutes ? 'Reminder ' + item.remindMinutes + ' minutes before, and at the deadline.' : 'Reminder at the deadline.';
    const actions = document.createElement('div'); actions.className = 'settings-row';
    const complete = document.createElement('button'); complete.type = 'button'; complete.textContent = item.completed ? 'Reopen' : 'Complete';
    complete.addEventListener('click', () => { void updateTask({ type: 'complete', id: item.id, completed: !item.completed }); });
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      if (taskBusy) return;
      editingTaskId = item.id;
      document.querySelector<HTMLInputElement>('#todo-title')!.value = item.title;
      const date = new Date(item.deadline);
      document.querySelector<HTMLInputElement>('#todo-deadline')!.value = new Date(item.deadline - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      document.querySelector<HTMLSelectElement>('#todo-remind')!.value = String(item.remindMinutes);
      document.querySelector('#todo-save')!.textContent = 'Save task';
      document.querySelector<HTMLElement>('#todo-cancel')!.hidden = false;
      taskEditor.scrollIntoView({ block: 'nearest' });
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => { if (await updateTask({ type: 'delete', id: item.id }) && editingTaskId === item.id) resetTaskEditor(); });
    actions.append(complete, edit, remove);
    row.append(title, deadline, reminder, actions);
    return row;
  }));
}

async function updateTask(input: import('./todos').TodoChange) {
  if (taskBusy) return false;
  taskBusy = true;
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#page-todos input, #page-todos select, #page-todos button')];
  controls.forEach(control => { control.disabled = true; });
  revision++;
  try {
    renderHome(await api.todo(input));
    document.querySelector('#todo-result')!.textContent = 'Task saved.';
    return true;
  } catch { document.querySelector('#todo-result')!.textContent = 'Could not save the task. Check the title and deadline and try again.'; return false; }
  finally { taskBusy = false; controls.forEach(control => { control.disabled = false; }); }
}

function resetTaskEditor() {
  editingTaskId = null;
  taskEditor.reset();
  document.querySelector('#todo-save')!.textContent = 'Add task';
  document.querySelector<HTMLElement>('#todo-cancel')!.hidden = true;
}
taskEditor.addEventListener('submit', async event => {
  event.preventDefault();
  const deadline = new Date(document.querySelector<HTMLInputElement>('#todo-deadline')!.value).getTime();
  const title = document.querySelector<HTMLInputElement>('#todo-title')!.value.trim();
  if (!title || !Number.isFinite(deadline) || (!editingTaskId && taskItems.length >= 100)) {
    document.querySelector('#todo-result')!.textContent = 'Enter a task and valid deadline. You can save up to 100 tasks.';
    return;
  }
  const input: import('./todos').TodoChange = { type: 'save', title, deadline, remindMinutes: Number(document.querySelector<HTMLSelectElement>('#todo-remind')!.value) };
  if (editingTaskId) input.id = editingTaskId;
  if (await updateTask(input)) resetTaskEditor();
});
document.querySelector('#todo-cancel')!.addEventListener('click', resetTaskEditor);
document.querySelector('#todo-filter')!.addEventListener('change', renderTodos);
