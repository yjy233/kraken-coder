import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix } from 'node:path';
import { parseDocument } from 'yaml';
import { Workspace, forbidden, ignored, isMissing } from '../tools/workspace.js';
import { errorMessage, openExtensionRoot, pluginManifest, type LocalPlugin } from './manifest.js';

export type { LocalPlugin } from './manifest.js';
export interface Skill { name: string; description: string; path: string; plugin?: string }
export interface ExtensionCatalog { skills: Skill[]; plugins: LocalPlugin[]; diagnostics: string[] }

// Public skill entries can be sent to clients. Only the host keeps filesystem capabilities.
const owners = new WeakMap<Skill, Workspace>();

function parseSkill(source: string, defaultName: string): Pick<Skill, 'name' | 'description'> {
  const front = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(source)?.[1];
  if (!front || front.length > 32_768) throw new Error('Expected YAML frontmatter up to 32 KB');
  const document = parseDocument(front, { prettyErrors: false });
  if (document.errors.length) throw new Error('Invalid YAML frontmatter');
  const name = document.get('name') ?? defaultName;
  const description = document.get('description');
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Invalid skill name');
  if (typeof description !== 'string' || !description.trim()) throw new Error('Expected a nonempty skill description');
  return { name, description: description.trim().replace(/\s+/g, ' ') };
}

async function discoverSkills(owner: Workspace, root: string, catalog: ExtensionCatalog, names: Set<string>, plugin?: string) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const path = pending.pop()!;
    try {
      const full = await owner.path(path, true);
      const stat = await lstat(full);
      let skillFile = path;
      if (stat.isDirectory()) {
        const entries = await readdir(full, { withFileTypes: true });
        visited += entries.length;
        if (visited > 10_000) {
          catalog.diagnostics.push(`Skill scan limit reached in ${plugin ?? owner.root}/${root}`);
          break;
        }
        if (!entries.some(entry => entry.name === 'SKILL.md')) {
          for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
            if (entry.isDirectory() && !ignored.has(entry.name) && !forbidden(entry.name)) {
              pending.push(posix.join(path, entry.name));
            }
          }
          continue;
        }
        skillFile = posix.join(path, 'SKILL.md');
      } else if (basename(path) !== 'SKILL.md') {
        throw new Error('Expected a skill directory or SKILL.md');
      }
      const meta = parseSkill(await owner.read(skillFile), basename(dirname(await owner.path(skillFile))));
      const name = plugin ? `${plugin}:${meta.name}` : meta.name;
      if (names.has(name)) throw new Error(`Duplicate skill name: ${name}`);
      const skill: Skill = { name, description: meta.description, path: skillFile };
      if (plugin) skill.plugin = plugin;
      names.add(name);
      owners.set(skill, owner);
      catalog.skills.push(skill);
    } catch (error) {
      catalog.diagnostics.push(`${plugin ?? owner.root}/${path}: ${errorMessage(error)}`);
    }
  }
}

async function scanIfPresent(owner: Workspace, root: string, catalog: ExtensionCatalog, names: Set<string>, required: boolean, plugin?: string) {
  try { await lstat(await owner.path(root, true)); }
  catch (error) {
    if (required || !isMissing(error)) catalog.diagnostics.push(`${plugin ?? owner.root}/${root}: ${errorMessage(error)}`);
    return;
  }
  await discoverSkills(owner, root, catalog, names, plugin);
}

export async function loadExtensionCatalog(workspace: Workspace, pluginRoots: readonly string[] = [], skillRoots: readonly string[] = []): Promise<ExtensionCatalog> {
  const catalog: ExtensionCatalog = { skills: [], plugins: [], diagnostics: [] };
  const names = new Set<string>();
  await scanIfPresent(workspace, '.agents/skills', catalog, names, false);
  for (const path of new Set(skillRoots)) {
    try { await discoverSkills(await openExtensionRoot(path), '.', catalog, names); }
    catch (error) { catalog.diagnostics.push(`${path}: ${errorMessage(error)}`); }
  }

  for (const path of new Set(pluginRoots)) {
    try {
      const owner = await openExtensionRoot(path);
      const { plugin, skills, explicitSkills } = await pluginManifest(owner, catalog.diagnostics);
      if (catalog.plugins.some(existing => existing.name === plugin.name)) throw new Error(`Duplicate plugin name: ${plugin.name}`);
      catalog.plugins.push(plugin);
      for (const root of new Set(skills)) await scanIfPresent(owner, root, catalog, names, explicitSkills, plugin.name);
    } catch (error) { catalog.diagnostics.push(`${path}: ${errorMessage(error)}`); }
  }
  return catalog;
}

export async function listSkills(workspace: Workspace): Promise<Skill[]> {
  return (await loadExtensionCatalog(workspace)).skills;
}

export async function readSkill(workspace: Workspace, skill: Skill, resource?: string): Promise<string> {
  const owner = owners.get(skill) ?? workspace;
  if (await realpath(owner.root) !== owner.root) throw new Error('Skill root has changed');
  if (resource === undefined) return owner.read(skill.path);
  if (!resource || isAbsolute(resource) || resource.includes('\\') || resource.split('/').includes('..')) {
    throw new Error('Use a skill-relative resource path');
  }
  return owner.read(posix.join(dirname(skill.path), resource));
}
