import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';
import type { Event, Provider } from '../src/core/types.js';
import { expandMcpInput, mcpHookText } from '../src/extensions/mcp-hook.js';

test('MCP hook templates preserve values, distinguish text interpolation and reject missing fields', () => {
  const event = { tool_input: { count: 2, paths: ['a', 'b'], flag: false } };
  const result = expandMcpInput({ count: '${tool_input.count}', nested: ['${tool_input.paths}', 'flag=${tool_input.flag}'] }, event);
  assert.deepEqual(result, { count: 2, nested: [['a', 'b'], 'flag=false'] });
  assert.throws(() => expandMcpInput({ fails: '${toString}' }, event), /not found/);
  assert.throws(() => expandMcpInput({ fails: '${tool_input.unknown}' }, event), /not found/);
  assert.equal(mcpHookText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
});

const server = `
const { createInterface } = require('node:readline');
const fs = require('node:fs');
fs.appendFileSync('starts','started\\n');
createInterface({input:process.stdin}).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  const reply = result => console.log(JSON.stringify({ jsonrpc:'2.0', id, result }));
  if (method === 'initialize') reply({ protocolVersion:params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'} });
  else if (method === 'tools/call') {
    fs.appendFileSync('calls', JSON.stringify(params)+'\\n');
    reply({ content:[{type:'text',text:JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'local guard declined'}})}] });
  }
});
`;

test('approved local MCP hook blocks its target without recursively triggering tool or permission hooks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-mcp-hook-')), workspace = join(root, 'work'), plugin = join(root, 'guard');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace);
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'hooks'));
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), '{"name":"guard"}');
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: ['server.cjs'] } } }));
  await writeFile(join(plugin, 'server.cjs'), server);
  const hook = { type: 'mcp_tool', server: 'local', tool: 'gate', input: { original: '${tool_input}', count: '${tool_input.limit}', text: 'tool:${tool_name}' } };
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: '*', hooks: [hook] }],
    PermissionRequest: [{ matcher: '*', hooks: [hook] }],
  } }));
  const config = { ...defaults, approval: 'ask' as const, plugins: [plugin] };
  const provider: Provider = { name: 'stub', async complete(messages) {
    if (messages.at(-1)!.role === 'user') return { content: '', toolCalls: [{id:'read',name:'read_file',arguments:'{"path":"sample","limit":7}'}] };
    return { content: messages.at(-1)!.content };
  } };
  async function run(session: string, approved: boolean) {
    const approvals: string[] = [], events: Event[] = [];
    const { answer } = await runTurn({ config, workspace, session, home: join(root, 'home'), provider, allowShell: true,
      approve: async action => { approvals.push(action.preview); return approved; }, emit: e => events.push(e),
    }, 'read');
    assert.equal(approvals.length, 1);
    assert.match(approvals[0]!, /MCP guard:local/);
    assert.match(approvals[0]!, /"count":7/);
    assert.deepEqual(events.filter(e => e.type === 'tool.start').map(e => e.name), ['read_file']);
    return JSON.parse(answer);
  }
  const refused = await run('refused', false);
  assert.match(refused.error, /Approval denied/);
  await assert.rejects(readFile(join(plugin, 'starts')), /ENOENT/);
  const executed = await run('allowed', true);
  assert.match(executed.error, /local guard declined/);
  const calls = (await readFile(join(plugin, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [{ name:'gate', arguments:{ original:{path:'sample',limit:7}, count:7, text:'tool:read_file' } }]);
});
