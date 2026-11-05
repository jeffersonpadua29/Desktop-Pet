import { mkdir, open, opendir, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { chatCloud, type AiRun, type CloudConfig, type ModelMessage, type ModelTool } from './cloud-ai';
import { projectEdit, type FileScope, type ProjectEdit } from './project-ai';
import { isWindowsFilename } from './file-rename';
import { conversationHistory, localOnlyRequest, needsConversationContext, needsPrivateContext, sharedAssistantRules } from './ai-context';
import { fileOperation, type FileOperation } from './file-agent';

export const model: string = require('../package.json').config.ollama_model;
const localChat = 'http://127.0.0.1:11434/api/chat';

export type Turn = { role: 'user' | 'assistant'; content: string };
export type PetContext = { name: string; food: number; energy: number; bond: number; asleep: boolean };
export type SpotifyContext = { query?: string; awaitingSelection?: true };
export type SpotifyAction = 'play' | 'pause' | 'toggle';
export type FileMatch = { name: string; folder: string; path: string; modified: number; canOpen: boolean };
type Search = { name: string; extension: string; date: string; exact?: true; folder?: FileScope };

const allowedExtensions = new Set([
  '.txt', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.rtf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.mp4',
]);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', '$recycle.bin']);
const fileFormats = ['txt', 'md', 'csv', 'json', 'html', 'css', 'js', 'ts', 'py', 'c', 'h', 'xlsx'] as const;
const generatedExtension = new RegExp('\\.(?:' + fileFormats.join('|') + ')(?!\\w|\\.\\w)', 'i');
type GeneratedFile = { name: string; content: string };
const fileFormatList = 'TXT, Markdown, CSV, Excel, JSON, HTML, CSS, JavaScript, TypeScript, Python, and C';

const launchTargets = ['spotify', 'downloads', 'calculator', 'arduino', 'vscode'] as const;
export type LaunchTarget = typeof launchTargets[number];
export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore';
function isLaunchTarget(value: unknown): value is LaunchTarget {
  return launchTargets.some(target => target === value);
}

export type Intent =
  | { type: 'reply'; message: string }
  | { type: 'find'; search: Search }
  | { type: 'create-file'; file: GeneratedFile; destination?: 'downloads'; openInVSCode?: true }
  | { type: 'project-edit'; edit: ProjectEdit }
  | { type: 'file-operation'; operation: FileOperation }
  | { type: 'open-in-vscode'; name?: string; folder?: FileScope }
  | { type: 'launch'; target: LaunchTarget }
  | { type: 'window'; action: 'list' }
  | { type: 'window'; action: WindowAction; target: string }
  | { type: 'spotify-search'; query: string; play?: true }
  | { type: 'spotify-playback'; action: SpotifyAction; query?: string; launch?: true }
  | { type: 'close'; target: 'spotify' }
  | { type: 'care'; action: 'feed' | 'pet' | 'wake' };

const tools: ModelTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Save one new file containing the requested content. Use only for a direct request to create or save a file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename only, including one of these extensions: ' + fileFormats.join(', ') + '. Default to .txt for an unspecified format.' },
          content: { type: 'string', description: 'Complete raw file contents without Markdown fences. For .xlsx, use a JSON array of rows, each an array of strings, numbers, booleans, or null. Use the first row for headers.' },
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
    .replace(/^(?:(?:ok(?:ay)?|now|then|actually|instead(?!\s+of\b)|please|paki)[,\s]+|(?:can|could|would|will) you\s+|(?:i need|i want) you to\s+|i (?:said|meant)[,\s]+|pa-)+/i, '')
    .replace(/^(?:buksan|i-open)\s+/i, 'open ')
    .replace(/^(?:hanapin|i-search)\s+(?:ang\s+)?/i, 'find ')
    .replace(/^(?:gawan mo ako ng|gumawa ka ng)\s+/i, 'create ');
}

function knownFileName(name: string) {
  const extension = extname(name).toLowerCase();
  return !/[<>:"/\\|?*\p{Cc}]/u.test(name) &&
    (allowedExtensions.has(extension) || fileFormats.some(format => extension === '.' + format));
}

function extractFileLocation(subject: string) {
  const location = /\s+(?:in|inside|under|from|sa)\s+(?:(?:my|the)\s+)?(downloads?|documents?|desktop)(?:\s+folder)?\.?$/i.exec(subject);
  const folderName = location?.[1].toLowerCase();
  const folder: FileScope | undefined = folderName === 'desktop' ? 'desktop' :
    folderName?.startsWith('download') ? 'downloads' : folderName ? 'documents' : undefined;
  return { target: (location ? subject.slice(0, location.index) : subject).trim(), folder };
}

export type NamedFile = { name: string; folder?: FileScope };

function literalFilename(text: string) {
  return text.trim().replace(/[.!?]+$/, '').replace(/^["“'`]|["”'`]$/g, '');
}

export function namedFileReference(text: string): NamedFile | undefined {
  const { target, folder } = extractFileLocation(text.trim().replace(/[!?]+$/, ''));
  const name = literalFilename(target);
  if (isWindowsFilename(name) && /^\.[a-z0-9_-]{1,16}$/i.test(extname(name)) &&
      (!/\s/.test(name) || /^["“'`]/.test(target))) {
    return { name, folder };
  }
}

export function renameRequest(text: string) {
  let command = commandText(text);
  const extension = /^(?:change|switch|set|update)\s+(?:(?:the|its|this|that)\s+)?(?:file\s+)?extension(?:\s+of\s+(.+?))?\s+(?:to|into|as)\s+\.?([a-z0-9]{1,16})(?:\s+instead(?:\s+of\s+\.?[a-z0-9]+)?)?[.!?]*$/i.exec(command);
  if (extension) command = 'rename ' + (extension[1] ?? 'it') + ' to .' + extension[2].toLowerCase();
  command = command.replace(/^(?:change|switch|set)\s+(it|this file|that file|the file)\s+(?:to|into)\s+(\.[a-z0-9]{1,16})[.!?]*$/i, 'rename $1 to $2');
  command = command.replace(/^(?:change|update|set)\s+(?:(?:the|its)\s+)?(?:file\s*name|filename|name)\s+(?:to|into|as)\s+/i, 'rename it to ');
  const filenameChange = /^(?:change|update|set)\s+(?:(?:the\s+)?(?:file\s*name|filename|name)\s+of\s+)?(.+?)\s+(?:to|into|as)\s+(.+)$/i.exec(command);
  if (filenameChange) {
    const from = filenameChange[1], to = literalFilename(filenameChange[2]);
    if ((namedFileReference(from) || /^(?:it|this file|that file|the file)$/i.test(from)) &&
        ((isWindowsFilename(to) && /^\.[a-z0-9_-]{1,16}$/i.test(extname(to))) || /^\.[a-z0-9]{1,16}$/i.test(to))) {
      command = 'rename ' + from + ' to ' + filenameChange[2];
    }
  }
  const action = /^rename(?:\s+([\s\S]+))?[.!?]*$/i.exec(command);
  if (!action) return;
  const subject = action[1]?.trim() ?? '';
  const separation = [...subject.matchAll(/"[^"]*"|“[^”]*”|`[^`]*`|'[^']*'|(?:^|\s+)(to|into|as)\s+/gi)].find(match => match[1]);
  const sourceText = (separation ? subject.slice(0, separation.index) : subject).trim()
    .replace(/^(?:the\s+)?file\s+(?:named\s+)?/i, '');
  const source = namedFileReference(sourceText);
  const invalidSource = Boolean(sourceText && !source && !/^(?:it|this|that|(?:(?:my|the|that|this|last)\s+)?(?:last\s+)?file)[.!?]*$/i.test(sourceText));
  return { source, newName: separation ? literalFilename(subject.slice(separation.index + separation[0].length)) : undefined, invalidSource };
}

export function canOpenAssistantFile(name: string) {
  return allowedExtensions.has(extname(name).toLowerCase());
}

function fileSearchRequest(command: string) {
  const match = /^(find|search(?: for)?|locate|look for)\s+(.+)$/i.exec(command);
  if (!match) return;
  const { target: query, folder } = extractFileLocation(match[2].replace(/[!?]$/, '').trim());
  const candidate = query.replace(/\.$/, '');
  const name = candidate.replace(/^(?:(?:a|the)\s+)?file\s+(?:(?:named|called)\s+)?/i, '')
    .replace(/^["“'`]|["”'`]$/g, '');
  const exact = name.length <= 120 && knownFileName(name) && (!/\s/.test(name) || name !== candidate) ? name : undefined;
  return { prompt: match[1] + ' ' + query, folder, exact };
}

function spotifyIntent(command: string, spotify?: SpotifyContext): Intent | undefined {
  if (/\b(?:unless|instead of|rather than)\b|\bnot\s+(?:on|in)\s+spotify\b|\b(?:and|but)\s+(?:not|never|do not|don['’]t)\b/i.test(command)) return;
  const compound = /^(?:open|launch|start)\s+(?:the\s+)?spotify\s+(?:and|then)\s+(.+)$/i.exec(command);
  const withApp = /^(.+?)\s+(?:on|in|sa)\s+spotify((?:,\s*|\s+)(?:and(?: then)?|then)\s+play(?: it)?)?[.!?]*$/i.exec(command);
  const request = compound?.[1] ?? (withApp ? withApp[1] + (withApp[2] ? ' ' + withApp[2].replace(/^[,\s]+/, '') : '') : command);
  const explicit = Boolean(compound || withApp);
  const transport = /^(play\/pause|play|resume|pause|stop|toggle(?: playback)?|press (?:the )?space(?:\s*bar)?(?: key)?)(?:\s+(.+?))?[.!?]*$/i.exec(request);
  if (transport) {
    const verb = transport[1].toLowerCase();
    const target = (transport[2] ?? '').replace(/(?:^|\s+)(?:now|again|please)$/i, '');
    const action: SpotifyAction = /^(?:play|resume)$/.test(verb) ? 'play' : /^(?:pause|stop)$/.test(verb) ? 'pause' : 'toggle';
    const reference = /^(?:it|that(?: song| track)?|the (?:song|track) you found)$/i.test(target);
    if (reference && spotify?.query && action === 'play') return { type: 'spotify-playback', action, query: spotify.query };
    const app = /^(?:the\s+)?spotify(?:\s+(?:app|music|playback))?$/i.test(target);
    const current = /^(?:(?:the|current)\s+)*(?:music|song|track|playback)$/i.test(target);
    if (spotify?.awaitingSelection && spotify.query && verb === 'play' && !compound &&
        (!target || /^(?:the\s+)?(?:song|track)$/i.test(target))) {
      return { type: 'spotify-playback', action, query: spotify.query };
    }
    if (app || current || (verb === 'stop' && target.toLowerCase() === 'playing') || (reference && (explicit || spotify)) ||
        (!target && (action !== 'toggle' || explicit || spotify))) {
      return { type: 'spotify-playback', action, ...(compound ? { launch: true } : {}) };
    }
  }
  const match = /^(search(?: for)?|find|play)\s+(.+?)[.!?]*$/i.exec(request);
  if (!match) return;
  const verb = match[1].toLowerCase();
  const tail = match[2];
  const playSuffix = /(?:,\s*|\s+)(?:and(?: then)?|then)\s+play(?: it)?$/i;
  const play = verb === 'play' || /^and play\s+/i.test(tail) || playSuffix.test(tail);
  if (!explicit) {
    if ((!spotify || verb === 'find') && !play) return;
    if (/^(?:(?:a|the|my)\s+)?(?:local\s+)?(?:file|folder|document|video|game)s?\b|\b(?:on|in|sa)\s+(?:my\s+|the\s+)?(?:pc|computer|desktop|documents|downloads|youtube|the web|the internet)\b|\bonline\s*$/i.test(tail)) return;
    if (knownFileName(tail.replace(playSuffix, '').replace(/^["“'`]|["”'`]$/g, ''))) return;
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

const leadingFileLocation = /^(?:in|inside)\s+(?:my\s+|the\s+)?(documents?|downloads?)(?:\s+(?:files?\s+)?folder)?[,\s]+/i;
const downloadsLocation = /\s+(?:in|inside|to|sa)\s+(?:my\s+|the\s+)?downloads?(?:\s+folder)?(?=[.!?]*$|[,\s]+(?:with|containing)\b)/i;
const openCreatedFile = /(?:,\s*|\s+)(?:and(?:\s+then)?|then)\s+open\s+(?:(?:it|that|the file)\s+)?(?:in|with|using|sa)\s+(?:vs\s*code|visual studio code)[.!?]*$/i;

function fileRequest(request: string) {
  const action = /^(create|generate|make|write|save|export|draft|build|put)\s+([\s\S]+)/i.exec(request);
  if (!action) return false;
  const subject = action[2];
  if (/^(?:the|a|an)?\s*(?:existing |original )?(?:file|document|spreadsheet)\s+(?:I (?:have|saved|found)|you found)\b/i.test(subject) ||
      /\b(?:without saving|(?:do not|don['’]t) (?:save|create))\b/i.test(subject)) return false;
  return /\b(?:file|document|spreadsheet|workbook|excel|script|markdown|csv|json|html|css|javascript|typescript|python|txt|pdf|docx|xlsx|pptx|c source)\b/i.test(subject) ||
    generatedExtension.test(subject) || /\band (?:save|export) (?:it|that|this)\b/i.test(subject) ||
    (/^(?:save|export)$/i.test(action[1]) && /^(?:it|this|that|the (?:answer|draft|reply|text))\b/i.test(subject));
}

function isGeneratedFilename(name: unknown): name is string {
  if (!isWindowsFilename(name) || name.length > 100) return false;
  const extension = extname(name).slice(1).toLowerCase();
  return fileFormats.some(format => format === extension);
}

type WorkbookCell = string | number | boolean | null;

function workbookRows(content: string): WorkbookCell[][] | undefined {
  try {
    const rows: unknown = JSON.parse(content);
    if (Array.isArray(rows) && rows.length <= 200 && rows.every(row => Array.isArray(row) && row.length <= 40 &&
        row.every(cell => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || Number.isFinite(cell)))) return rows;
  } catch { /* Invalid structured workbook data. */ }
}

function validateGeneratedFile(name: unknown, content: unknown, allowEmpty: boolean): GeneratedFile | undefined {
  if (!isGeneratedFilename(name) || typeof content !== 'string' ||
      (!allowEmpty && !content.trim()) || content.includes('\0') ||
      Buffer.byteLength(content, 'utf8') > 32_768) return;
  const extension = extname(name).toLowerCase();
  if (extension === '.xlsx' && !workbookRows(content)) return;
  if (extension === '.json') {
    try { JSON.parse(content); } catch { return; }
  }
  return { name, content };
}

export async function saveGeneratedFile(folder: string, file: GeneratedFile): Promise<FileMatch> {
  let content: string | Buffer = file.content;
  if (/\.xlsx$/i.test(file.name)) {
    const rows = workbookRows(file.content);
    if (!rows) throw new Error('Invalid workbook data.');
    const { default: writeExcelFile } = await import('write-excel-file/node');
    const data = rows.map((row, index) => index === 0
      ? row.map(value => value === null ? null : { value, fontWeight: 'bold' as const })
      : row);
    content = await writeExcelFile([{ sheet: 'Sheet1', data }]).toBuffer();
  }
  await mkdir(folder, { recursive: true });
  const path = join(folder, file.name);
  const output = await open(path, 'wx');
  try {
    await output.writeFile(content, 'utf8');
    await output.close();
  } catch (error) {
    await output.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  return { name: file.name, folder, path, modified: Date.now(), canOpen: /\.(?:txt|md|json|xlsx)$/i.test(file.name) };
}

function assistantRules(pet: PetContext | undefined, scope: string, tool?: string, filename?: string) {
  const profile = pet && JSON.stringify({
    name: pet.name, fullness: Math.round(pet.food), energy: Math.round(pet.energy),
    bond: Math.round(pet.bond), asleep: pet.asleep,
  });
  const base = sharedAssistantRules;
  if (tool === 'create_file') return base +
    ' Return the complete requested contents with create_file. Follow the requested format and constraints, including requests to omit code comments. If asked to save a previous answer, use that answer as the contents. Pet Pocket handles saving and any other requested action.' +
    (filename ? ' Use this exact filename: ' + JSON.stringify(filename) + '.' : ' Choose a filename without a folder path.');
  if (tool === 'find_files') return base +
    ' Use find_files to extract the filename or keyword, extension, and modification date. Pet Pocket searches ' + scope + ' and reports the results.';
  if (tool) return base + ' Use only the supplied tool for the requested action. Pet Pocket executes it and reports the result.';
  return base +
    ' Answer the question directly and omit internal reasoning. You cannot inspect the screen or browse the web. This chat step has no direct file access. Ask Pet can create files, find files, read or review supported UTF-8 text/source files up to 32 KB, open files, propose edits for review, rename files, and move one exact file to the Recycle Bin. For a file request that has not been resolved, ask for its exact filename or a selected search result. Do not invent file contents. Pet Pocket handles supported Windows actions. Do not claim you performed an action.' +
    (profile ? ' Pet profile: ' + profile + '. Fullness below 30 means hungry and energy below 25 means tired.' : '');
}

function cleanReply(content: unknown) {
  if (typeof content !== 'string') return '';
  const reply = content
    .replace(/<(think|analysis|reasoning|tool_call)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .trim();
  if (/^(?:okay[,.!]?\s+)?(?:the user\b|let me (?:check|think)\b|i need to (?:decide|figure out)\b)/i.test(reply)) return '';
  return reply.slice(0, 6000);
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

type OllamaMessage = ModelMessage;

async function readModelReply(response: Response, onDraft?: (text: string) => void): Promise<OllamaMessage> {
  if (!onDraft || !response.body) {
    const data = await response.json() as { message?: OllamaMessage; error?: string; done_reason?: string };
    if (data.error || data.done_reason === 'length' || !data.message) throw new Error('Incomplete local response.');
    return data.message ?? {};
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  const toolCalls: NonNullable<OllamaMessage['tool_calls']> = [];
  let complete = false;
  const readLine = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as { message?: OllamaMessage; error?: string; done?: boolean; done_reason?: string };
    if (chunk.error || chunk.done_reason === 'length') throw new Error('Incomplete local response.');
    if (chunk.done) complete = true;
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
    if (!complete) throw new Error('Incomplete local stream.');
    return { content, tool_calls: toolCalls };
  } finally { reader.releaseLock(); }
}

export async function interpret(turns: Turn[], pet: PetContext, scope: string, onDraft?: (text: string) => void, spotify?: SpotifyContext,
  ai?: { cloud?: CloudConfig; onRun?: (run: AiRun) => void; hasFileContext?: boolean }): Promise<Intent> {
  const latest = turns.at(-1)?.content ?? '';
  const command = commandText(latest);
  const editor = /^open\s+(?:(.+?)\s+)?(?:in|with|using|sa)\s+(?:vs\s*code|visual studio code)[.!?]*$/i.exec(command);
  if (editor) {
    const { target, folder } = extractFileLocation(editor[1]?.trim() ?? '');
    if (!target || /^(?:it|that|this|(?:(?:that|this|the)\s+)?(?:last\s+)?file(?:\s+you\s+(?:just\s+)?(?:created|made|found|saved))?)$/i.test(target)) {
      return { type: 'open-in-vscode', folder };
    }
    const name = target.replace(/^(?:the\s+)?file\s+(?:named\s+)?/i, '').replace(/^["“'`]|["”'`]$/g, '');
    return { type: 'open-in-vscode', name, folder };
  }
  const desktop = windowIntent(command);
  if (desktop) return desktop;
  const edit = projectEdit(command, ai?.hasFileContext);
  if (edit) return { type: 'project-edit', edit };
  const operation = fileOperation(command, ai?.hasFileContext);
  if (operation) return 'error' in operation ? { type: 'reply', message: operation.error } : { type: 'file-operation', operation };
  const music = spotifyIntent(command, spotify);
  if (music) return music;
  const quick = quickIntent(command || latest, pet.name);
  if (quick) return quick;
  if (/^(?:open|close|quit|exit|minimize|maximize|restore)\s+(?:it|that|this)[.!?]*$/i.test(command)) {
    return { type: 'reply', message: 'Which app or file do you mean?' };
  }
  const leadingLocation = leadingFileLocation.exec(command);
  const fileCommand = command.replace(leadingFileLocation, '');
  const tool = fileRequest(fileCommand) ? 'create_file' : requestedTool(command);
  const fileSearch = tool === 'find_files' ? fileSearchRequest(command) : undefined;
  const searchFolder = fileSearch?.folder ? { folder: fileSearch.folder } : {};
  if (fileSearch?.exact) return { type: 'find', search: { name: fileSearch.exact, extension: '', date: 'any', exact: true, ...searchFolder } };
  const fileBody = fileCommand.replace(openCreatedFile, '');
  const inDownloads = /^download/i.test(leadingLocation?.[1] ?? '') || downloadsLocation.test(fileBody);
  const creation = {
    ...(inDownloads ? { destination: 'downloads' as const } : {}),
    ...(openCreatedFile.test(fileCommand) ? { openInVSCode: true as const } : {}),
  };
  if (tool === 'create_file' && /\b(?:as\s+(?:(?:an?|the)\s+)?|^(?:create|generate|make|write|save|export|draft|build)\s+(?:(?:me|us)\s+)?(?:(?:an?|the)\s+)?)(?:pdf|docx|pptx|word\s+document)\b|\.(?:pdf|docx|pptx)(?=["'”’\s.!?]|$)/i.test(command)) {
    return { type: 'reply', message: 'That file format isn’t available in Ask Pet yet. I can save ' + fileFormatList + ' files.' };
  }
  let filename: string | undefined;
  let prompt = fileSearch?.prompt ?? latest;
  if (tool === 'create_file') {
    const request = fileBody.replace(downloadsLocation, '');
    prompt = request;
    const named = /^(create|make|generate|write|save|export|draft|build|put)\s+(?:me\s+)?(?:an?\s+)?(?:(?:new|blank|empty)\s+)?(?:file\s+(?:named|called)\s+)?(?:"([^"]+)"|“([^”]+)”|`([^`]+)`|([^\s]+?\.[a-z0-9]+))(?:[\s,]+((?:with|containing|that|for|using|implementing|and)\b[\s\S]*))?[.!?]*$/i.exec(request);
    if (named) {
      const name = named[2] ?? named[3] ?? named[4] ?? named[5];
      if (!isGeneratedFilename(name)) return { type: 'reply', message: 'Use a filename with a supported extension and no folder path.' };
      filename = name;
      if (!named[6] && /^(?:create|make)$/i.test(named[1])) {
        const extension = extname(name).toLowerCase();
        const content = extension === '.json' ? '{}\n' : extension === '.xlsx' ? '[]' : '';
        return { type: 'create-file', file: { name, content }, ...creation };
      }
    }
  }
  const previousAnswer = turns.slice(0, -1).reverse().find(turn => turn.role === 'assistant')?.content;
  const saveAnswer = /^(?:save|export)\s+(?:it|this|that|(?:the\s+)?(?:(?:previous|last)\s+)?(?:answer|reply|response|text|draft))\s+as\s+["“'`]?([^"”'`]+\.(?:txt|md))["”'`]?[.!?]*$/i.exec(fileBody.replace(downloadsLocation, ''));
  if (tool === 'create_file' && saveAnswer) {
    if (!previousAnswer) return { type: 'reply', message: 'Which answer should I save? Send the text or ask me to read the file first.' };
    const file = validateGeneratedFile(saveAnswer[1].trim(), previousAnswer, false);
    return file ? { type: 'create-file', file, ...creation } : { type: 'reply', message: 'That answer is too large to save as one file (32 KB maximum), or the filename is invalid.' };
  }
  if (tool === 'create_file' && previousAnswer && previousAnswer.length > 10_000 && needsConversationContext(command)) {
    return { type: 'reply', message: 'That previous answer is too large for a complete model conversion. Save it directly as a .txt or .md file, or give me a smaller section to convert.' };
  }
  const activeTools = tool ? tools.filter(entry => entry.function.name === tool) : [];
  const system = assistantRules(pet, fileSearch?.folder ?? scope, tool, filename);
  const allowEmpty = /\b(?:empty|blank)\b/i.test(command);
  const needsLocalContext = turns.some(turn => turn.role === 'user' && localOnlyRequest(turn.content)) ||
    needsPrivateContext(command) || needsConversationContext(command);
  const desktopCommand = /^(?:open|launch|start|buksan|close|exit|quit|shut|focus|minimize|maximize|restore)\b/i.test(command);
  let fallback: CloudConfig['provider'] | undefined;
  if (ai?.cloud && (!tool || tool === 'create_file') && !needsLocalContext && !desktopCommand) {
    try {
      const result = await chatCloud(ai.cloud, assistantRules(undefined, scope, tool, filename), prompt, activeTools, tool ? 4096 : 1200);
      if ((result.tool_calls?.length ?? 0) > 1) throw new Error('Ambiguous provider actions.');
      const call = result.tool_calls?.[0]?.function;
      if (tool === 'create_file') {
        const file = call?.name === tool && validateGeneratedFile(filename ?? call.arguments?.name, call.arguments?.content, allowEmpty);
        if (!file) throw new Error('Invalid generated file.');
        ai.onRun?.({ engine: ai.cloud.provider });
        return { type: 'create-file', file, ...creation };
      }
      const reply = cleanReply(result.content);
      if (call || !reply) throw new Error('Invalid chat response.');
      ai.onRun?.({ engine: ai.cloud.provider });
      return { type: 'reply', message: reply };
    } catch {
      fallback = ai.cloud.provider;
    }
  }
  ai?.onRun?.({ engine: 'qwen', ...(fallback ? { fallback } : {}) });
  const draft = tool ? undefined : onDraft;
  const history = conversationHistory(turns);
  const signal = AbortSignal.timeout(tool === 'create_file' ? 180_000 : 90_000);
  let message: OllamaMessage;
  try {
    const response = await fetch(localChat, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model, stream: Boolean(draft), think: false, keep_alive: '15m',
        ...(tool ? { tools: activeTools } : {}),
        options: { num_ctx: 8192, num_predict: tool === 'create_file' ? 4096 : tool ? 256 : 1200, temperature: tool ? 0 : .25 },
        messages: [{
          role: 'system',
          content: system,
        }, ...history, { role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) return {
      type: 'reply',
      message: response.status === 404
        ? 'The local model is missing. Run npm run setup:ai and try again.'
        : 'Ollama could not answer this request. Try again in a moment.',
    };
    message = await readModelReply(response, draft);
  } catch (error) {
    draft?.('');
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      return { type: 'reply', message: tool === 'create_file'
        ? 'The local model timed out while writing the contents. No file was saved.'
        : 'The local model took too long. Try a shorter request.' };
    }
    return { type: 'reply', message: 'Ollama could not return a complete answer. No action was run. Check that Ollama is running and try again.' };
  }
  if ((message.tool_calls?.length ?? 0) > 1) return { type: 'reply', message: 'The model proposed multiple actions. No action was run. Please request one action at a time.' };
  const call = message.tool_calls?.[0]?.function;
  if (call && call.name !== tool) return { type: 'reply', message: 'No action was run. Please ask directly if you want me to use a tool.' };
  const args = call?.arguments;
  if (call?.name === 'create_file') {
    const file = validateGeneratedFile(filename ?? args?.name, args?.content, allowEmpty);
    return file ? { type: 'create-file', file, ...creation } : { type: 'reply', message: 'Qwen didn’t return valid file contents. No file was saved.' };
  }
  if (call?.name === 'find_files' && args) {
    const name = typeof args.name === 'string' ? args.name.trim().slice(0, 120) : '';
    const extension = typeof args.extension === 'string' ? args.extension.trim().replace(/^\./, '').toLowerCase() : '';
    const date = typeof args.date === 'string' && ['today', 'yesterday', 'last7days'].includes(args.date) ? args.date : 'any';
    if (!name && !extension && date === 'any') return { type: 'reply', message: 'What do you remember about the file? A word in the name, file type, or date would help.' };
    return { type: 'find', search: { name, extension, date, ...searchFolder } };
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
  if (desktopCommand &&
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
  const name = search.name.toLowerCase();
  const tokens = name.split(/\s+/).filter(Boolean);
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
        if (!entry.isFile()) continue;
        const filename = entry.name.toLowerCase();
        if (search.exact ? filename !== name : !tokens.every(token => filename.includes(token))) continue;
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







