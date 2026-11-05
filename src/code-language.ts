import { basename, extname } from 'node:path';
import { isWindowsFilename } from './file-rename';

const languages: Record<string, string> = {
  c: '.c', 'c++': '.cpp', cpp: '.cpp', 'c#': '.cs', csharp: '.cs', cs: '.cs',
  python: '.py', py: '.py', javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts',
  rust: '.rs', rs: '.rs', go: '.go',
};
const languageNames = 'c\\+\\+|c#|csharp|cpp|python|javascript|typescript|rust|cs|py|js|ts|rs|go|c';

export function conversionTarget(command: string) {
  const named = /\b(?:to|as)\s+(?:"([^"]+)"|“([^”]+)”|`([^`]+)`|([\w-]+\.[a-z]+))(?=[\s.!?]|$)/i.exec(command);
  const outputName = named?.[1] ?? named?.[2] ?? named?.[3] ?? named?.[4];
  if (outputName && isWindowsFilename(outputName) && Object.values(languages).includes(extname(outputName).toLowerCase())) {
    return { outputName, outputExtension: extname(outputName).toLowerCase() };
  }
  const target = new RegExp('(?:\\b(?:to|into|in|as|use|be)\\s+(?:(?:a|an|the)\\s+)?|\\b(?:make|do|write)\\s+(?:it|this|that)\\s+|^)\\.?(' + languageNames + ')(?=$|[\\s,.!?])', 'i').exec(command);
  return target ? { outputExtension: languages[target[1].toLowerCase()] } : undefined;
}

export function convertedFilename(file: string, target: { outputName?: string; outputExtension?: string }) {
  const name = basename(file);
  return target.outputName ?? (target.outputExtension ? name.slice(0, name.length - extname(name).length) + target.outputExtension : name);
}
