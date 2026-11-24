import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRegistry, type Approve } from '../src/tools/registry.js';
import { algorithms } from '../src/learning/index.js';
import type { Event, Policy } from '../src/core/types.js';
import { inspectPluginMcp, registerPluginMcp } from '../src/extensions/mcp.js';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';

const stub = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync('starts', process.pid + '\\n');
const send = obj => console.log(JSON.stringify({ jsonrpc: '2.0', ...obj }));
let initialized = false;
createInterface({ input: process.stdin }).on('line', text => {
  const { id, method, params, result } = JSON.parse(text);
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:'fixture',version:'1'} } });
  } else if (method === 'notifications/initialized') {
    initialized = true;
  } else if (!initialized) send({ id, error: {code:-32600, message:'not ready'} });
  else if (method === 'tools/list') send({ id, result: {tools: (params.cursor ? ['last'] : ['echo','hidden']).map(name=>({name,inputSchema:{type:'object'}})), nextCursor:params.cursor ? undefined : 'next' } });
  else if (method === 'tools/call') {
    if (params.name === 'wait') { appendFileSync('waiting', 'yes'); return; }
    if (params.name === 'tool-error') { send({id,result:{isError:true,content:[{type:'text',text:'tool rejected'}]}}); return; }
    if (params.name === 'rpc-error') { send({id,error:{code:-32602,message:'bad args'}}); return; }
    send({id,result:{content:[{type:'text',text:'done'}],structuredContent:{args:params.arguments,root:process.env.CODEX_PLUGIN_ROOT,setting:process.env.RESOURCE,inherited:!!process.env.KRAKEN_MCP_TEST_SENTINEL,pid:process.pid}}});
  }
});
`;

async function fixture(t: import('node:test').TestContext, options: { policy?: Policy; shell?: boolean; approve?: Approve; config?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kraken-mcp-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'server.mjs'), stub);
  const events: Event[] = [];
  const emit = (e: Event) => { events.push(e); };
  const registry = new ToolRegistry({ policy: options.policy ?? 'ask', shellEnabled: options.shell ?? true, algorithms: algorithms('reference'),
    approve: options.approve ?? (async () => true), emit });
  const config = { command: process.execPath, args: ['${CODEX_PLUGIN_ROOT}/server.mjs'], env: { RESOURCE: '${CLAUDE_PLUGIN_ROOT}/data' }, disabled_tools:['hidden'], ...options.config };
  const mcp = registerPluginMcp(registry, [{ name:'pack', root, mcpServers:{stdio:config} }], emit);
  t.after(() => mcp.close());
  const run = async (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const reply = await registry.execute({id:'test',name,arguments:JSON.stringify({server:'pack:stdio',...args})}, signal);
    return JSON.parse(reply.content);
  };
  return { root, events, mcp, registry, run };
}

test('MCP stdio starts only after approval, negotiates once per turn, filters tools and preserves structured output', async t => {
  const old = process.env.KRAKEN_MCP_TEST_SENTINEL;
  process.env.KRAKEN_MCP_TEST_SENTINEL = 'must-not-be-forwarded';
  t.after(() => { if (old === undefined) delete process.env.KRAKEN_MCP_TEST_SENTINEL; else process.env.KRAKEN_MCP_TEST_SENTINEL = old; });
  const {root,events,mcp,run} = await fixture(t);
  const starts = join(root,'starts');
  await assert.rejects(readFile(starts),{code:'ENOENT'});
  const first = await run('mcp_list_tools',{});
  assert.equal(first.ok,true);
  assert.deepEqual(first.result.tools.map((x:{name:string})=>x.name),['echo']);
  assert.equal(first.result.nextCursor,'next');
  const second = await run('mcp_list_tools',{cursor:first.result.nextCursor});
  assert.equal(second.result.tools[0].name,'last');
  assert.match((await run('mcp_call_tool',{tool:'hidden'})).error,/disabled/);
  const args = { a: 1.5, nested:[null, true, { unicode:'辛苦了' }] };
  const reply = await run('mcp_call_tool',{tool:'echo',arguments_json:JSON.stringify(args)});
  assert.equal(reply.ok,true);
  const observed = reply.result.structuredContent;
  assert.deepEqual(observed.args,args);
  assert.equal(observed.root,root);
  assert.equal(observed.setting,join(root,'data'));
  assert.equal(observed.inherited,false);
  assert.equal((await readFile(starts,'utf8')).trim(),String(observed.pid));
  const previews = events.filter(e=>e.type==='approval.request').map(e=>String(e.preview));
  assert.equal(previews.length,3);
  assert.ok(previews[2]?.includes('pack:stdio') && previews[2].includes(join(root,'server.mjs')) && previews[2].includes('辛苦了'));
  assert.match((await run('mcp_call_tool',{tool:'rpc-error'})).error,/bad args/);
  assert.match((await run('mcp_call_tool',{tool:'tool-error'})).error,/tool rejected/);
  mcp.close();
  assert.match((await run('mcp_list_tools',{})).error,/turn ended/);
});

test('MCP denied by shell gate, read-only policy, or human approval never runs the executable', async t => {
  for (const options of [{policy:'read-only' as const},{shell:false},{approve:async()=>false}]) {
    const {root,run} = await fixture(t,options);
    for (const [name,args] of [['mcp_list_tools',{}],['mcp_call_tool',{tool:'echo'}]] as const) {
      assert.match((await run(name,args)).error,/denied/);
    }
    await assert.rejects(readFile(join(root,'starts')),{code:'ENOENT'});
  }
});

test('MCP timeout tears down the server; retry starts a fresh connection', async t => {
  const {root,run} = await fixture(t,{config:{tool_timeout_sec:0.12}});
  const wait = await run('mcp_call_tool',{tool:'wait'});
  assert.equal(wait.ok,false);
  assert.match(wait.error,/timeout/i);
  assert.equal((await run('mcp_list_tools',{})).ok,true);
  assert.equal((await readFile(join(root,'starts'),'utf8')).trim().split('\n').length,2);
});

test('MCP cancellation rejects a pending call and a later approved call reconnects', async t => {
  const {root,run} = await fixture(t);
  const controller = new AbortController();
  const waiting = run('mcp_call_tool',{tool:'wait'},controller.signal);
  let observed = false;
  for (let i=0; i<100 && !observed; i++) {
    try { observed = (await readFile(join(root,'waiting'),'utf8')) === 'yes'; } catch { await delay(10); }
  }
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(waiting,/cancel fixture/);
  assert.ok(observed,'the fixture must enter tools/call before cancellation');
  assert.equal((await run('mcp_list_tools',{})).ok,true);
});

test('Unrecognized transports and unsafe environment forwarding are diagnostic and do not advertise MCP tools', async t => {
  for (const config of [{url:'https://example.invalid',type:'http'}, {env_vars:['OPENAI_API_KEY']}]) {
    const {registry,events} = await fixture(t,{config});
    assert.deepEqual(registry.schemas(),[]);
    assert.equal(events.some(e=>e.type==='extension.diagnostic'),true);
  }
});

test('runTurn discovers MCP in a real local plugin, approves discovery and execution, and receives the tool result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-mcp-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const plugin = join(root, 'pack');
  await Promise.all([mkdir(workspace), mkdir(plugin)]);
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'pack', version: '0.1.0',
  }));
  await writeFile(join(plugin, 'server.mjs'), stub);
  await writeFile(join(plugin, 'mcp.json'), JSON.stringify({
    mcpServers: { stdio: { command: process.execPath, args: ['./server.mjs'] } },
  }));
  const approvals: string[] = [];
  const events: Event[] = [];
  let pid = 0;
  const result = await runTurn({
    workspace, home: join(root, 'home'), session: 'mcp', allowShell: true,
    config: { ...defaults, mode: 'learner', approval: 'ask', plugins: [plugin] },
    emit: event => { events.push(event); },
    approve: async request => { approvals.push(request.name); return true; },
    provider: { name: 'fixture', async complete(messages, tools) {
      const last = messages.at(-1)!;
      if (last.role === 'user') {
        const discover = tools.find(tool => tool.name === 'mcp_list_tools');
        assert.deepEqual(discover?.parameters.properties?.server?.enum, ['pack:stdio']);
        await assert.rejects(readFile(join(plugin, 'starts')), { code: 'ENOENT' });
        return { content: '', toolCalls: [{ id: 'discover', name: 'mcp_list_tools', arguments: '{"server":"pack:stdio"}' }] };
      }
      assert.equal(last.role, 'tool');
      const observed = JSON.parse(last.content);
      assert.equal(observed.ok, true);
      if (last.toolCallId === 'discover') {
        const remote = observed.result.tools.find((tool: { name: string }) => tool.name === 'echo');
        assert.equal(remote.inputSchema.type, 'object');
        const args = { server: 'pack:stdio', tool: remote.name, arguments_json: '{"message":"hello"}' };
        return { content: '', toolCalls: [{ id: 'invoke', name: 'mcp_call_tool', arguments: JSON.stringify(args) }] };
      }
      assert.equal(last.toolCallId, 'invoke');
      pid = observed.result.structuredContent.pid;
      return { content: observed.result.structuredContent.args.message };
    } },
  }, 'Discover the plugin echo tool and call it.');
  assert.equal(result.answer, 'hello');
  assert.deepEqual(approvals, ['mcp_list_tools', 'mcp_call_tool']);
  assert.equal((await readFile(join(plugin, 'starts'), 'utf8')).trim(), String(pid));
  assert.equal(events.filter(event => event.type === 'tool.end' && event.ok).length, 2);
});

test('MCP hook preparation is scoped and lazy, uses the approved argument snapshot, and shares the turn client', async t => {
  const { root, mcp, run } = await fixture(t);
  const starts = join(root, 'starts');
  assert.throws(() => mcp.prepareHook('unrelated', 'stdio', 'echo', {}), /Unknown MCP server/);
  assert.throws(() => mcp.prepareHook('pack', 'stdio', 'hidden', {}), /disabled/);
  const args = { nested: { value: 'approved' } };
  const call = mcp.prepareHook('pack', 'stdio', 'echo', args);
  const canonical = mcp.prepareHook(undefined, 'pack:stdio', 'echo', args);
  assert.equal(call.preview, canonical.preview);
  assert.equal(mcp.prepareHook(undefined, 'stdio', 'echo', args).preview, canonical.preview);
  assert.ok(call.preview.includes('pack:stdio') && call.preview.includes(process.execPath) && call.preview.includes('"approved"'));
  args.nested.value = 'changed later';
  await assert.rejects(readFile(starts), { code: 'ENOENT' });
  const result = await call.run(new AbortController().signal) as { structuredContent: { args: typeof args; pid: number } };
  assert.equal(result.structuredContent.args.nested.value, 'approved');
  assert.equal((await run('mcp_list_tools', {})).ok, true);
  assert.equal((await readFile(starts, 'utf8')).trim(), String(result.structuredContent.pid));
});

test('Standalone MCP hook rejects an ambiguous bare server without starting either backend', () => {
  const emit = () => {};
  const registry = new ToolRegistry({ policy: 'ask', shellEnabled: true, algorithms: algorithms('reference'), approve: async () => false, emit });
  const plugins = ['first', 'second'].map(name => ({ name, root: tmpdir(), mcpServers: { shared: { command: process.execPath } } }));
  const mcp = registerPluginMcp(registry, plugins, emit);
  try {
    assert.throws(() => mcp.prepareHook(undefined, 'shared', 'echo', {}), /Ambiguous MCP server/);
    assert.match(mcp.prepareHook('first', 'shared', 'echo', {}).preview, /MCP first:shared/);
  } finally { mcp.close(); }
});

test('MCP inventory returns the same usable IDs as the registry without launching or exposing private config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-mcp-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'server.mjs'), stub);
  const secret = 'a-private-fixture-value';
  const plugins = [{ name: 'pack', root, mcpServers: {
    good: { command: process.execPath, args: ['./server.mjs', secret], env: { TOKEN: secret } },
    remote: { url: 'https://example.invalid/' + secret },
    disabled: { enabled: false },
    bad: { command: [secret] },
    typo: { command: process.execPath, enabled: 'false' },
    ['invalid ' + secret]: {},
  } }];
  const result = inspectPluginMcp(plugins);
  assert.deepEqual(result.servers, ['pack:good']);
  assert.equal(result.diagnostics.length, 4);
  assert.match(result.diagnostics.join('\n'), /pack:remote: Only local stdio/);
  for (const privateValue of [secret, root, process.execPath, 'server.mjs', 'TOKEN']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
  const registry = new ToolRegistry({ policy: 'ask', shellEnabled: true, algorithms: algorithms('reference'),
    approve: async () => false, emit: () => {} });
  const mcp = registerPluginMcp(registry, plugins, () => {});
  t.after(() => mcp.close());
  const exposed = registry.schemas().find(tool => tool.name === 'mcp_list_tools')?.parameters.properties?.server?.enum;
  assert.deepEqual(exposed, result.servers);
  await assert.rejects(readFile(join(root, 'starts')), { code: 'ENOENT' });
});
