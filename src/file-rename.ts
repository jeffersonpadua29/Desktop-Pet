import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

export function isWindowsFilename(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    !/^[ .]|[ .]$|[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(name);
}

const moveFileCommand = Buffer.from(
  "$ErrorActionPreference = 'Stop'; [System.IO.File]::Move($env:PET_POCKET_RENAME_FROM, $env:PET_POCKET_RENAME_TO)",
  'utf16le',
).toString('base64');

export async function renameLocalFile(path: string, newName: string) {
  if (!isWindowsFilename(newName)) throw new Error('Invalid destination filename.');
  const destination = join(dirname(path), newName);
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', moveFileCommand], {
      windowsHide: true, timeout: 10_000,
      env: { ...process.env, PET_POCKET_RENAME_FROM: path, PET_POCKET_RENAME_TO: destination },
    }, error => error ? reject(error) : resolve());
  });
  return destination;
}
