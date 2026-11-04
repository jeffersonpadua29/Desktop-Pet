import { randomUUID } from 'node:crypto';

export type Todo = { id: string; title: string; deadline: number; remindMinutes: number; completed: boolean; reminded: boolean; dueNotified: boolean };
export type TodoChange = { type: 'save'; id?: string; title: string; deadline: number; remindMinutes: number } | { type: 'complete'; id: string; completed: boolean } | { type: 'delete'; id: string };
const reminderOptions = [0, 5, 15, 30, 60, 1440];

function validTodo(value: unknown): value is Todo {
  if (!value || typeof value !== 'object') return false;
  const item = value as Todo;
  return typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(item.id) && typeof item.title === 'string' && !!item.title.trim() && item.title.length <= 140 &&
    Number.isSafeInteger(item.deadline) && item.deadline > 0 && item.deadline <= 8640000000000000 && reminderOptions.includes(item.remindMinutes);
}

export function restoreTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  return input.filter(validTodo).filter(item => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  }).slice(0, 100).map(item => ({ id: item.id, title: item.title.trim(), deadline: item.deadline, remindMinutes: item.remindMinutes,
    completed: item.completed === true, reminded: item.reminded === true, dueNotified: item.dueNotified === true }));
}

export function changeTodo(todos: Todo[], input: unknown): Todo[] {
  if (!input || typeof input !== 'object') throw new Error('Invalid task.');
  const change = input as TodoChange;
  const previous = todos.find(item => item.id === change.id);
  if (change.type === 'save') {
    if ((change.id && !previous) || (!change.id && todos.length >= 100)) throw new Error('Task unavailable or task limit reached.');
    const item: Todo = { id: previous?.id ?? randomUUID(), title: change.title, deadline: change.deadline, remindMinutes: change.remindMinutes,
      completed: previous?.completed ?? false, reminded: false, dueNotified: false };
    if (!validTodo(item)) throw new Error('Enter a title, valid deadline, and reminder time.');
    item.title = item.title.trim();
    if (previous && previous.deadline === item.deadline && previous.remindMinutes === item.remindMinutes) {
      item.reminded = previous.reminded;
      item.dueNotified = previous.dueNotified;
    }
    return previous ? todos.map(value => value.id === item.id ? item : value) : [...todos, item];
  }
  if (!previous) throw new Error('Task no longer exists.');
  if (change.type === 'delete') return todos.filter(item => item.id !== change.id);
  if (change.type === 'complete' && typeof change.completed === 'boolean') {
    if (previous.completed === change.completed) return todos;
    return todos.map(item => item.id === change.id ? { ...item, completed: change.completed, reminded: false, dueNotified: false } : item);
  }
  throw new Error('Invalid task action.');
}

export function pendingReminders(todos: Todo[], now: number) {
  return todos.filter(item => !item.completed && (!item.dueNotified && now >= item.deadline || !item.reminded && item.remindMinutes > 0 && now >= item.deadline - item.remindMinutes * 60000 && now < item.deadline))
    .map(item => ({ item, due: now >= item.deadline }));
}

export function reminderMessage(items: Todo[], due: boolean) {
  const titles = items.slice(0, 3).map(item => item.title.slice(0, 80) + (due ? '' : ', due ' + new Date(item.deadline).toLocaleString())).join('. ');
  const rest = items.length > 3 ? ' And ' + (items.length - 3) + ' more tasks. Open your to-do list.' : '';
  return (due ? 'Deadline reminder. ' : 'Upcoming deadline. ') + titles + '.' + rest;
}
