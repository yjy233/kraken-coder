import type { Config } from '../config.js';
import { Workspace } from '../tools/workspace.js';
import { loadExtensionCatalog } from './catalog.js';
import { inspectHooks } from './hooks.js';
import { inspectPluginMcp } from './mcp.js';

/** Public metadata only. Manifests may contain private environment values and hook commands. */
export async function extensionInventory(workspace: string, config: Config) {
  const catalog = await loadExtensionCatalog(await Workspace.open(workspace), config.plugins, config.skillRoots);
  const { hooks, diagnostics: hookWarnings } = await inspectHooks(catalog.plugins, config.hookFiles ?? []);
  const { servers, diagnostics: mcpWarnings } = inspectPluginMcp(catalog.plugins);
  return {
    skills: catalog.skills.map(({ name, description, path, plugin }) => ({ name, description, path, plugin })),
    hooks,
    plugins: catalog.plugins.map(({ name, version, description }) => ({
      name, version, description, hookEvents: [...new Set(hooks.filter(h => h.source === name).map(h => h.event))],
      mcpServers: servers.filter(id => id.startsWith(name + ':')).map(id => id.slice(name.length + 1)),
    })),
    diagnostics: [...catalog.diagnostics, ...hookWarnings, ...mcpWarnings],
  };
}
export type ExtensionInventory = Awaited<ReturnType<typeof extensionInventory>>;
