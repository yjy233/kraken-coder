import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

// Each expression matches one complete display option. Paths and other operands
// are intentionally excluded from these remembered command families.
const displayOptions = new Map<string, RegExp>([
  ['git status', /^(?:-[sb]{1,2}|--(?:short|branch|show-stash|porcelain(?:=v[12])?|untracked-files(?:=no|=normal|=all)?))$/],
  ['git ls-files', /^(?:-[cmdostz]+|--(?:cached|modified|deleted|others|stage|exclude-standard))$/],
  ['ls', /^-[alhtrAFd]+$/],
  ['pwd', /^-[LP]$/],
]);
const projectScripts = new Set([
  'npm test', 'npm run test', 'npm run build', 'npm run typecheck', 'npm run lint', 'npm run verify',
]);

export function commandRule(command: string): string | undefined {
  // Validate before trimming so even leading/trailing newlines require approval.
  if (/[^a-zA-Z0-9= \t-]/.test(command)) return undefined;
  const words = command.trim().split(/[ \t]+/);
  if (words[0] === 'npm') {
    const invocation = words.join(' ');
    return projectScripts.has(invocation) ? invocation : undefined;
  }
  const name = words.splice(0, words[0] === 'git' ? 2 : 1).join(' ');
  const option = displayOptions.get(name);
  return option && words.every(word => option.test(word)) ? name : undefined;
}

function defaultStore(): string {
  // KRAKEN_HOME and the workspace .env belong to the project.
  return join(userInfo().homedir, '.kraken-coder', 'command-rules');
}

async function ruleDirectory(workspace: string, store: string, create: boolean): Promise<string> {
  const root = await realpath(workspace);
  if (create) await mkdir(store, { recursive: true, mode: 0o700 });
  const canonicalStore = await realpath(store);
  const fromWorkspace = relative(root, canonicalStore);
  if (fromWorkspace !== '..' && !fromWorkspace.startsWith('..' + sep) && !isAbsolute(fromWorkspace)) {
    throw new Error('Command rules must be stored outside the workspace');
  }
  const directory = join(canonicalStore, createHash('sha256').update(root).digest('hex'));
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid command rule directory');
  return directory;
}

export async function hasCommandRule(workspace: string, rule: string, store?: string): Promise<boolean> {
  if (commandRule(rule) !== rule) return false;
  try {
    const directory = await ruleDirectory(workspace, store ?? defaultStore(), false);
    return (await lstat(join(directory, rule))).isFile();
  } catch {
    // A missing or unreadable grant takes the normal approval path.
    return false;
  }
}

export async function rememberCommandRule(workspace: string, rule: string, store = defaultStore()): Promise<void> {
  if (commandRule(rule) !== rule) throw new Error('Unknown command rule');
  const directory = await ruleDirectory(workspace, store, true);
  const marker = join(directory, rule);
  try {
    // One atomic, empty marker per grant also keeps concurrent CLI/server writes independent.
    await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(marker)).isFile()) throw error;
  }
}
