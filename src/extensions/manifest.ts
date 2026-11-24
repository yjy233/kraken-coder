import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { object } from '../core/validation.js';
import { Workspace, isMissing } from '../tools/workspace.js';

const AGENT_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const LEGACY_MANIFEST = '.codex-plugin/plugin.json';
type ConfigObject = Record<string, unknown>;

export interface LocalPlugin {
  name: string;
  root: string;
  version?: string;
  description?: string;
  hooks: ConfigObject[];
  mcpServers: ConfigObject;
}

export async function openExtensionRoot(path: string): Promise<Workspace> {
  if (!isAbsolute(path)) throw new Error('Extension roots must be absolute paths');
  const root = resolve(path);
  if (!(await lstat(root)).isDirectory()) throw new Error('Extension root must be a directory, not a symlink');
  return Workspace.open(root);
}

async function jsonFile(owner: Workspace, path: string, optional = false): Promise<ConfigObject | undefined> {
  let contents: string;
  try { contents = await owner.read(path); }
  catch (error) { if (optional && isMissing(error)) return undefined; throw error; }
  try { return object(JSON.parse(contents)); }
  catch { throw new Error(`Invalid JSON object in ${path}`); }
}

function manifestPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.slice(2).split('/').some(s => !s || s === '.' || s === '..')) {
    throw new Error('Plugin resource paths must start with ./ and stay inside the package');
  }
  return value.slice(2);
}

async function hookConfigs(owner: Workspace, input: unknown): Promise<ConfigObject[]> {
  if (input === undefined) {
    const hooks = await jsonFile(owner, 'hooks/hooks.json', true);
    return hooks ? [hooks] : [];
  }
  const configs: ConfigObject[] = [];
  for (const entry of Array.isArray(input) ? input : [input]) {
    if (typeof entry === 'string') configs.push((await jsonFile(owner, manifestPath(entry)))!);
    else configs.push(object(entry));
  }
  return configs;
}

async function serverConfigs(owner: Workspace, input: unknown, portable: boolean): Promise<ConfigObject> {
  let value: ConfigObject | undefined;
  if (input === undefined) value = await jsonFile(owner, portable ? 'mcp.json' : '.mcp.json', true);
  else if (typeof input === 'string') value = await jsonFile(owner, manifestPath(input));
  else value = object(input);
  if (!value) return {};
  return Object.hasOwn(value, 'mcpServers') ? object(value.mcpServers) : value;
}

export async function pluginManifest(owner: Workspace, diagnostics: string[]) {
  const candidate = await jsonFile(owner, 'plugin.json', true);
  const portable = typeof candidate?.$schema === 'string' && candidate.$schema.startsWith('https://agent-plugins.org/schemas/');
  if (portable && candidate.$schema !== AGENT_SCHEMA) throw new Error('Unsupported Agent Plugins schema in plugin.json');
  const manifest = portable ? candidate : await jsonFile(owner, LEGACY_MANIFEST, true);
  if (!manifest) throw new Error('Expected Agent Plugins v1 plugin.json or .codex-plugin/plugin.json');
  const name = manifest.name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name) || /--|\.\./.test(name)) {
    throw new Error('Invalid plugin name');
  }

  const skillPaths = portable ? undefined : manifest.skills;
  const skills = skillPaths === undefined ? ['skills'] : (Array.isArray(skillPaths) ? skillPaths : [skillPaths]).map(manifestPath);
  if (!skills.length) skills.push('skills');

  const plugin: LocalPlugin = { name, root: owner.root, hooks: [], mcpServers: {} };
  if (typeof manifest.version === 'string') plugin.version = manifest.version;
  if (typeof manifest.description === 'string') plugin.description = manifest.description;
  if (manifest.apps !== undefined) diagnostics.push(`${name}: app connectors are not supported`);
  try {
    // Standard packages may carry Codex hook declarations in an extension or a legacy overlay.
    let hookFields = manifest;
    if (portable) {
      const extensions = manifest.extensions === undefined ? {} : object(manifest.extensions);
      const extension = extensions['com.openai'];
      hookFields = extension === undefined ? (await jsonFile(owner, LEGACY_MANIFEST, true) ?? {}) : object(extension);
    }
    plugin.hooks = await hookConfigs(owner, hookFields.hooks);
  } catch (error) { diagnostics.push(`${name} hooks: ${errorMessage(error)}`); }
  try {
    plugin.mcpServers = await serverConfigs(owner, portable ? undefined : manifest.mcpServers, portable);
  } catch (error) { diagnostics.push(`${name} MCP: ${errorMessage(error)}`); }
  return { plugin, skills, explicitSkills: skillPaths !== undefined };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
