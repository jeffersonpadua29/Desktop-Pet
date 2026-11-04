import { mkdir, open, opendir, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const model: string = require('../package.json').config.ollama_model;
const localChat = 'http://127.0.0.1:11434/api/chat';

export type Turn = { role: 'user' | 'assistant'; content: string };
export type PetContext = { name: string; food: number; energy: number; bond: number; asleep: boolean };
export type SpotifyContext = { query?: string };
export type FileMatch = { name: string; folder: string; path: string; modified: number; canOpen: boolean };
type Search = { name: string; extension: string; date: string };

const allowedExtensions = new Set([
  '.txt', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.rtf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.mp4',
]);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', '$recycle.bin']);
const fileFormats = ['txt', 'md', 'csv', 'json', 'html', 'css', 'js', 'ts', 'py', 'c', 'h'] as const;
const generatedExtension = new RegExp('\\.(?:' + fileFormats.join('|') + ')(?!\\w|\\.\\w)', 'i');
type GeneratedFile = { name: string; content: string };
const fileFormatList = 'TXT, Markdown, CSV, JSON, HTML, CSS, JavaScript, TypeScript, Python, and C';

const launchTargets = ['spotify', 'downloads', 'calculator', 'arduino', 'vscode'] as const;
export type LaunchTarget = typeof launchTargets[number];
export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore';
function isLaunchTarget(value: unknown): value is LaunchTarget {
  return launchTargets.some(target => target === value);
}

export type Intent =
  | { type: 'reply'; message: string }
  | { type: 'find'; search: Search }
  | { type: 'create-file'; file: GeneratedFile }
  | { type: 'open-in-vscode'; name?: string; folder?: 'documents' }
  | { type: 'launch'; target: LaunchTarget }
  | { type: 'window'; action: 'list' }
  | { type: 'window'; action: WindowAction; target: string }
  | { type: 'spotify-search'; query: string; play?: true }
  | { type: 'close'; target: 'spotify' }
  | { type: 'care'; action: 'feed' | 'pet' | 'wake' };

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Save one new file containing the requested content. Use only for a direct request to create or save a file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename only, including one of these extensions: ' + fileFormats.join(', ') + '. Default to .txt for an unspecified format.' },
          content: { type: 'string', description: 'Complete file contents. Use raw text, without a surrounding Markdown code fence.' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find local files by filename, extension, or modification date.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename keyword, or empty if unknown.' },
          extension: { type: 'string', description: 'File extension without a dot, or empty if unknown.' },
          date: { type: 'string', enum: ['any', 'today', 'yesterday', 'last7days'] },
        },
        required: ['name', 'extension', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_shortcut',
      description: 'Launch a supported app or Downloads when explicitly requested. Use arduino for Arduino IDE.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: launchTargets } },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_spotify',
      description: 'Open Spotify search results for the requested song, artist, or album. This tool does not start playback.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Song, artist, or album name, without command words.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_spotify',
      description: 'Close the Spotify desktop window when explicitly asked to close, quit, or exit Spotify.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'care_for_pet',
      description: 'Perform a requested care action on the active pet.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['feed', 'pet', 'wake'] } },
        required: ['action'],
      },
    },
  },
];

function commandText(text: string) {
  return text.trim()
    .replace(/^(?:hi|hello|hey)[\s,.!]+/i, '')
    .replace(/^(?:(?:ok(?:ay)?)[, ]+)?(?:(?:can|could|would|will) you\s+|(?:i need|i want) you to\s+)?(?:please\s+|pa-)?/i, '');
}

function spotifyIntent(command: string, spotify?: SpotifyContext): Intent | undefined {
  if (/\b(?:unless|instead of|rather than)\b|\bnot\s+(?:on|in)\s+spotify\b|\b(?:and|but)\s+(?:not|never|do not|don['’]t)\b/i.test(command)) return;
  const compound = /^(?:open|launch|start)\s+(?:the\s+)?spotify\s+(?:and|then)\s+(.+)$/i.exec(command);
  const withApp = /^(.+?)\s+(?:on|in)\s+spotify[.!?]*$/i.exec(command);
  const request = compound?.[1] ?? withApp?.[1] ?? command;
  if (spotify?.query && /^play\s+(?:it|that(?: song| track)?|the (?:song|track) you found)[.!?]*$/i.test(request)) {
    return { type: 'reply', message: 'Select the track in the Spotify results for “' + spotify.query + '” to start playback.' };
  }
  const explicit = Boolean(compound || withApp);
  const match = explicit || spotify
    ? /^(search(?: for)?|find|play)\s+(.+?)[.!?]*$/i.exec(request)
    : null;
  if (!match) return;
  const verb = match[1].toLowerCase();
  const tail = match[2];
  const playSuffix = /\s+(?:and(?: then)?|then)\s+play(?: it)?$/i;
  const play = verb === 'play' || /^and play\s+/i.test(tail) || playSuffix.test(tail);
  if (!explicit) {
    if (verb === 'find' && !play) return;
    if (/^(?:(?:a|the|my)\s+)?(?:local\s+)?(?:file|folder|document)s?\b|\b(?:on|in)\s+(?:my\s+|the\s+)?(?:pc|computer|desktop|documents|downloads|youtube|the web|the internet)\b|\bonline\s*$/i.test(tail)) return;
    if (allowedExtensions.has(extname(tail.replace(/^["“]|["”]$/g, '')).toLowerCase())) return;
  }
  const query = tail.replace(/^and play\s+/i, '').replace(playSuffix, '')
    .replace(/^(?:the\s+)?(?:song|track|album|artist)\s+/i, '').trim().replace(/^["“']+|["”'!?]+$/g, '').slice(0, 160);
  if (query && !/^not\s|^(?:it|this|that|music|next|previous)$/i.test(query)) {
    return play ? { type: 'spotify-search', query, play: true } : { type: 'spotify-search', query };
  }
}

function windowIntent(command: string): Intent | undefined {
  const text = command.replace(/[.!?]+$/, '').trim();
  if (/^(?:list|show(?: me)?|what are)\s+(?:the\s+|my\s+)?open (?:windows|apps)$/i.test(text) ||
      /^what (?:windows|apps) are open$/i.test(text)) return { type: 'window', action: 'list' };
  const match = /^(focus(?: on)?|switch to|bring up|minimize|maximize|restore)\s+(.+)$/i.exec(text);
  if (!match || /\b(?:and then|instead of|rather than)\b/i.test(match[2])) return;
  const verb = match[1].toLowerCase();
  const action = verb === 'minimize' || verb === 'maximize' || verb === 'restore' ? verb : 'focus';
  const target = match[2].replace(/^the\s+/i, '').replace(/\s+window$/i, '').replace(/^["“]|["”]$/g, '').trim();
  if (target && !/^(?:all(?: windows| apps)?|everything)$/i.test(target)) return { type: 'window', action, target: target.slice(0, 160) };
}

function requestedTool(command: string) {
  if (/^(?:open|launch|start|search|find|play)\b/i.test(command) && /\bspotify\b/i.test(command) &&
      /\b(?:search|find|play)\b/i.test(command) && !/\b(?:not|never|unless|instead of|rather than)\b/i.test(command)) return 'search_spotify';
  if (/^(?:find|search(?: for)?|locate|look for)\s/i.test(command) &&
      !/\b(?:on the web|on the internet|online|the web|the internet)\b/i.test(command)) return 'find_files';
  if (/\b(?:not|never|unless|instead of|rather than)\b/i.test(command)) return undefined;
  if (/^(?:open|launch|start|buksan)\s/i.test(command) &&
      /\b(?:spotify|downloads|calculator|arduino|vs\s*code|visual studio code)\b/i.test(command)) return 'open_shortcut';
  if (/^(?:close|exit|quit|shut(?: down)?)\s/i.test(command) && /\bspotify\b/i.test(command)) return 'close_spotify';
  if (/^(?:feed|pet|wake(?: up)?)\s/i.test(command)) return 'care_for_pet';
  return undefined;
}

function fileRequest(command: string) {
  const request = command.replace(/^(?:in|inside)\s+(?:my\s+|the\s+)?documents?(?:\s+(?:files?\s+)?folder)?[,\s]+/i, '');
  const action = /^(create|generate|make|write|save|export|draft|build|put)\s+([\s\S]+)/i.exec(request);
  if (!action) return false;
  const subject = action[2];
  if (/^(?:the|a|an)?\s*(?:existing |original )?(?:file|document|spreadsheet)\s+(?:I (?:have|saved|found)|you found)\b/i.test(subject) ||
      /\b(?:without saving|(?:do not|don['’]t) (?:save|create))\b/i.test(subject)) return false;
  return /\b(?:file|document|spreadsheet|script|markdown|csv|json|html|css|javascript|typescript|python|txt|pdf|docx|xlsx|pptx|c source)\b/i.test(subject) ||
    generatedExtension.test(subject) || /\band (?:save|export) (?:it|that|this)\b/i.test(subject) ||
    (/^(?:save|export)$/i.test(action[1]) && /^(?:it|this|that|the (?:answer|draft|reply|text))\b/i.test(subject));
}

function validateGeneratedFile(args: Record<string, unknown> | undefined, allowEmpty: boolean): GeneratedFile | undefined {
  const { name, content } = args ?? {};
  if (typeof name !== 'string' || !name || name.length > 100 ||
      /^[ .]|[ .]$|[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(name)) return;
  const extension = extname(name).slice(1).toLowerCase();
  if (!fileFormats.some(format => format === extension) ||
      typeof content !== 'string' || (!allowEmpty && !content.trim()) || content.includes('\0') ||
      Buffer.byteLength(content, 'utf8') > 32_768) return;
  if (extension === 'json') {
    try { JSON.parse(content); } catch { return; }
  }
  return { name, content };
}

export async function saveGeneratedFile(documents: string, file: GeneratedFile): Promise<FileMatch> {
  const folder = join(documents, 'Pet Pocket');
  await mkdir(folder, { recursive: true });
  const path = join(folder, file.name);
  const output = await open(path, 'wx');
  try {
    await output.writeFile(file.content, 'utf8');
    await output.close();
  } catch (error) {
    await output.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  return { name: file.name, folder, path, modified: Date.now(), canOpen: /\.(?:txt|md|json)$/i.test(file.name) };
}

function assistantRules(pet: PetContext, scope: string, tool?: string) {
  const profile = JSON.stringify({
    name: pet.name, fullness: Math.round(pet.food), energy: Math.round(pet.energy),
    bond: Math.round(pet.bond), asleep: pet.asleep,
  });
  return [
    'You are the Pet Pocket companion. Reply in plain English and lead with the answer.',
    'Give a brief answer to a simple question. For a complex request, explain the useful steps or reasoning in the answer itself. Omit internal deliberation.',
    'The user is on Windows. For desktop instructions, use Windows terminology and avoid guessing shortcuts or claiming knowledge of the user’s installed apps.',
    'If details are missing, make a reasonable assumption and label it, or ask one specific question when it would change the answer. Say when you are unsure.',
    'Respond to the latest user message. Use recent turns to resolve references and corrections. If two interpretations remain plausible, ask one focused question. Do not repeat an earlier action unless the user requests it again.',
    'Use currentPet for questions about your name and care stats. Fullness below 30 means hungry and energy below 25 means tired. Do not infer access to the screen, web, or file contents.',
    'currentPet: ' + profile,
    tool
      ? 'Use the supplied tool for the current requested action. Ask for missing arguments. Only the app reports action results.' +
        (tool === 'find_files' ? ' File search covers ' + scope + '.' : '') +
        (tool === 'create_file' ? ' Generate the full contents and call create_file. Honor the requested filename, format, and content constraints, including requests to omit code comments. Use an appropriate filename if none is given. Reuse prior chat text if asked to save it. Ask what the file should contain if no topic or text is given. The app saves files in Documents → Pet Pocket, so pass a filename only.' : '')
      : 'Answer questions normally. Pet Pocket can create and find local files, open those files in VS Code, launch supported shortcuts, manage open windows, and open Spotify search. Track playback requires selection in Spotify. Describe only relevant capabilities and never claim an action ran on this turn.',
  ].join(' ');
}

function cleanReply(content: unknown) {
  if (typeof content !== 'string') return '';
  const reply = content
    .replace(/<(think|analysis|reasoning|tool_call)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .trim();
  if (/^(?:okay[,.!]?\s+)?(?:the user\b|let me (?:check|think)\b|i need to (?:decide|figure out)\b)/i.test(reply)) return '';
  return reply.slice(0, 1600);
}

function quickIntent(text: string, petName: string): Intent | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(hi|hello|hey)$/.test(normalized)) return { type: 'reply', message: 'Hi, I’m ' + petName + '. What can I help with?' };
  if (/^(?:create|generate|make|save|write)\s+(?:(?:me|us)\s+)?(?:(?:a|one)\s+)?files?\??$/.test(normalized)) {
    return { type: 'reply', message: 'Yes. What should the file contain? I can create ' + fileFormatList + ' files.' };
  }
  if (/^[?]+$/.test(normalized)) return { type: 'reply', message: 'What would you like me to clarify?' };
  if (/^(?:(?:ok(?:ay)?)[, ]+)?(?:please\s+)?(?:close|exit|quit)\s+(?:the\s+)?spotify(?:\s+(?:app|window))?(?:\s+please)?$/.test(normalized)) return { type: 'close', target: 'spotify' };
  const opening = /^(?:please\s+)?(?:open|launch|start|buksan)\s+(?:the\s+)?(.+?)(?:\s+please)?$/.exec(normalized);
  const target = opening?.[1]?.trim();
  if (target === 'arduino ide' || target === 'arduino ide 2') return { type: 'launch', target: 'arduino' };
  if (target && /^(?:vs\s*code|visual studio code)\??$/.test(target)) return { type: 'launch', target: 'vscode' };
  if (isLaunchTarget(target)) return { type: 'launch', target };
  return undefined;
}

type OllamaMessage = {
  content?: string;
  tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
};

async function readModelReply(response: Response, onDraft?: (text: string) => void): Promise<OllamaMessage> {
  if (!onDraft || !response.body) {
    const data = await response.json() as { message?: OllamaMessage };
    return data.message ?? {};
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  const toolCalls: NonNullable<OllamaMessage['tool_calls']> = [];
  const readLine = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as { message?: OllamaMessage; error?: string };
    if (chunk.error) throw new Error('Ollama streaming error');
    content += chunk.message?.content ?? '';
    if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
    if (toolCalls.length) onDraft('');
    else if (content.length >= 44) onDraft(cleanReply(content));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    }
    readLine(pending + decoder.decode());
    return { content, tool_calls: toolCalls };
  } finally { reader.releaseLock(); }
}

export async function interpret(turns: Turn[], pet: PetContext, scope: string, onDraft?: (text: string) => void, spotify?: SpotifyContext): Promise<Intent> {
  const latest = turns.at(-1)?.content ?? '';
  const command = commandText(latest).replace(/^(?:now|then|actually|instead)[,\s]+/i, '');
  const editor = /^open\s+(?:(.+?)\s+)?(?:in|with|using)\s+(?:vs\s*code|visual studio code)[.!?]*$/i.exec(command);
  if (editor) {
    const subject = editor[1]?.trim() ?? '';
    const location = /\s+(?:in|inside|from)\s+(?:(?:my|the)\s+)?documents?(?:\s+(?:files?\s+)?folder)?$/i.exec(subject);
    const target = location ? subject.slice(0, location.index).trim() : subject;
    const folder = location ? 'documents' : undefined;
    if (!target || /^(?:it|that|this|(?:(?:that|this|the)\s+)?(?:last\s+)?file(?:\s+you\s+(?:just\s+)?(?:created|made|found|saved))?)$/i.test(target)) {
      return { type: 'open-in-vscode', folder };
    }
    const name = target.replace(/^(?:the\s+)?file\s+(?:named\s+)?/i, '').replace(/^["“'`]|["”'`]$/g, '');
    return { type: 'open-in-vscode', name, folder };
  }
  const desktop = windowIntent(command);
  if (desktop) return desktop;
  const music = spotifyIntent(command, spotify);
  if (music) return music;
  const quick = quickIntent(command || latest, pet.name);
  if (quick) return quick;
  const tool = fileRequest(command) ? 'create_file' : requestedTool(command);
  if (tool === 'create_file' && /\b(?:as\s+(?:(?:an?|the)\s+)?|^(?:create|generate|make|write|save|export|draft|build)\s+(?:(?:me|us)\s+)?(?:(?:an?|the)\s+)?)(?:pdf|docx|xlsx|pptx|word\s+document|excel\s+(?:file|spreadsheet|workbook))\b|\.(?:pdf|docx|xlsx|pptx)(?=["'”’\s.!?]|$)/i.test(command)) {
    return { type: 'reply', message: 'That file format isn’t available in Ask Pet yet. I can save ' + fileFormatList + ' files.' };
  }
  const draft = tool ? undefined : onDraft;
  const history = turns.slice(-7, -1).map(turn => ({
    role: turn.role, content: turn.content.slice(0, tool === 'create_file' ? 1600 : 600),
  }));
  let response: Response;
  try {
    response = await fetch(localChat, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model, stream: Boolean(draft), think: false, keep_alive: '15m',
        ...(tool ? { tools: tools.filter(entry => entry.function.name === tool) } : {}),
        options: { num_ctx: tool === 'create_file' ? 6144 : 3072, num_predict: tool === 'create_file' ? 2048 : tool ? 120 : 240, temperature: tool ? 0 : .25 },
        messages: [{
          role: 'system',
          content: assistantRules(pet, scope, tool),
        }, ...history, { role: 'user', content: latest }],
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { type: 'reply', message: 'The local model took too long. Try a shorter request.' };
    }
    return { type: 'reply', message: 'I could not reach Ollama on this PC. Run npm run setup:ai and try again.' };
  }
  if (!response.ok) return {
    type: 'reply',
    message: response.status === 404
      ? 'The local model is missing. Run npm run setup:ai and try again.'
      : 'Ollama could not answer this request. Try again in a moment.',
  };
  const message = await readModelReply(response, draft);
  const call = message.tool_calls?.[0]?.function;
  if (call && call.name !== tool) return { type: 'reply', message: 'No action was run. Please ask directly if you want me to use a tool.' };
  const args = call?.arguments;
  if (call?.name === 'create_file') {
    const file = validateGeneratedFile(args, /\b(?:empty|blank)\b/i.test(command));
    return file ? { type: 'create-file', file } : { type: 'reply', message: 'I couldn’t generate a valid file. Try a supported extension or a shorter request.' };
  }
  if (call?.name === 'find_files' && args) {
    const name = typeof args.name === 'string' ? args.name.trim().slice(0, 120) : '';
    const extension = typeof args.extension === 'string' ? args.extension.trim().replace(/^\./, '').toLowerCase() : '';
    const date = typeof args.date === 'string' && ['today', 'yesterday', 'last7days'].includes(args.date) ? args.date : 'any';
    if (!name && !extension && date === 'any') return { type: 'reply', message: 'What do you remember about the file? A word in the name, file type, or date would help.' };
    return { type: 'find', search: { name, extension, date } };
  }
  if (call?.name === 'open_shortcut' && args && isLaunchTarget(args.target)) {
    return { type: 'launch', target: args.target };
  }
  if (call?.name === 'search_spotify' && typeof args?.query === 'string' && args.query.trim()) {
    return { type: 'spotify-search', query: args.query.trim().slice(0, 160) };
  }
  if (call?.name === 'close_spotify') return { type: 'close', target: 'spotify' };
  if (call?.name === 'care_for_pet' && args && (args.action === 'feed' || args.action === 'pet' || args.action === 'wake')) {
    return { type: 'care', action: args.action };
  }
  if (call) return { type: 'reply', message: 'I could not use that action. Please rephrase your request.' };
  const reply = cleanReply(message.content);
  if (tool === 'create_file') {
    return { type: 'reply', message: 'No file was saved.' + (reply.endsWith('?') ? ' ' + reply : ' Tell me what to put in it, or try a shorter request.') };
  }
  if (/^(?:open|launch|start|buksan|close|exit|quit|shut)\b/i.test(command) &&
      /\b(?:opened|launched|started|closed|exited|quit|is open|is now open|is running|successfully)\b/i.test(reply)) {
    return { type: 'reply', message: 'I couldn’t confirm that action. I can open Spotify, Arduino IDE, Calculator, or Downloads, and close the Spotify window.' };
  }
  return { type: 'reply', message: reply || 'I did not finish my reply. Please try again.' };
}

function modifiedWindow(date: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (date === 'yesterday') start.setDate(start.getDate() - 1);
  else end.setDate(end.getDate() + 1);
  if (date === 'last7days') start.setDate(start.getDate() - 6);
  return date === 'any' ? [-Infinity, Infinity] : [start.getTime(), end.getTime()];
}

export async function findFiles(roots: string[], search: Search) {
  const dirs = [...new Set(roots)];
  const tokens = search.name.toLowerCase().split(/\s+/).filter(Boolean);
  const [after, before] = modifiedWindow(search.date);
  const matches: FileMatch[] = [];
  const deadline = Date.now() + 6500;
  let inspected = 0;
  for (let i = 0; i < dirs.length; i++) {
    try {
      const folder = dirs[i];
      const entries = await opendir(folder);
      for await (const entry of entries) {
        if (++inspected > 16000 || Date.now() > deadline) return { files: matches.sort((a, b) => b.modified - a.modified).slice(0, 12), limited: true };
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name.toLowerCase())) dirs.push(path);
          continue;
        }
        if (!entry.isFile() || !tokens.every(token => entry.name.toLowerCase().includes(token))) continue;
        const extension = extname(entry.name).toLowerCase();
        if (search.extension && extension !== '.' + search.extension) continue;
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.mtimeMs < after || info.mtimeMs >= before) continue;
        matches.push({ name: basename(path), folder, path, modified: info.mtimeMs, canOpen: allowedExtensions.has(extension) });
      }
    } catch { /* A folder may be unavailable or unreadable. */ }
  }
  return { files: matches.sort((a, b) => b.modified - a.modified).slice(0, 12), limited: false };
}







