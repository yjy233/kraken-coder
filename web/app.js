import { AgentClient } from '/client.js';

const $ = id => document.getElementById(id);
const tokenKey = 'kraken.server.token';
const selectionKey = 'kraken.server.session';
const policyLabels = { 'read-only': '只读模式', ask: '操作需审批', 'workspace-write': '工作区可写', 'full-auto': '自动执行' };
const state = {
  client: null, info: null, sessions: [], selectedId: null, events: [], turn: null, approvals: [],
  delta: '', reasoningDelta: '', streamingReasoningOpen: true, stream: null, generation: 0, authGeneration: 0, connected: false,
  submitting: false, creating: false, cancelling: false, settingsBusy: false, pendingApprovals: new Set(),
  expandedTools: new Set(), expandedReasoning: new Set(), connection: 'connecting', notice: '',
};
const tokenFromLink = new URLSearchParams(location.hash.slice(1)).get('token');
let initialToken = tokenFromLink || '';
try {
  if (tokenFromLink) sessionStorage.setItem(tokenKey, tokenFromLink);
  else initialToken = sessionStorage.getItem(tokenKey) || '';
} catch { /* Restricted browser storage still permits this tab's connection. */ }
if (tokenFromLink) history.replaceState(null, '', location.pathname + location.search);

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}
function text(id, value) { $(id).textContent = value; }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function showNotice(message = '') {
  state.notice = message;
  text('notice', message);
  $('notice').hidden = !message;
}
function setConnection(status) {
  state.connection = status;
  const labels = { connecting: '连接中', live: '已连接', reconnecting: '重新连接', offline: '未连接' };
  text('connection-text', labels[status]);
  const dotClass = status === 'live' ? 'online' : status === 'offline' ? 'offline' : 'connecting';
  $('sidebar-dot').className = `connection-dot ${dotClass}`;
  $('connection-badge').querySelector('.connection-dot').className = `connection-dot ${dotClass}`;
  text('server-label', state.info ? `本地服务 · API v${state.info.version}` : '等待本地服务连接');
  renderControls();
}
function configure(info) {
  state.info = info;
  const name = info.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || info.workspace;
  text('workspace-name', name);
  text('workspace-location', info.workspace);
  $('workspace-location').title = info.workspace;
  text('composer-model', info.model || (info.provider === 'demo' ? '离线 Demo' : info.provider));
  $('composer-model').title = info.model || info.provider;
  text('composer-permission', policyLabels[info.approval] || info.approval);
  text('config-provider', info.provider);
  text('config-mode', info.mode);
  text('config-approval', info.approval);
  text('config-shell', info.shellEnabled ? '已启用' : '未启用');
  text('config-protocol', `HTTP + SSE · v${info.version}`);
  text('config-request-timeout', `${Number((info.requestTimeoutMs / 60000).toFixed(3))} 分钟`);
  text('config-turn-timeout', `${Number((info.turnTimeoutMs / 3600000).toFixed(3))} 小时`);
  if (info.provider === 'demo') {
    const suggestions = [...$('suggestions').querySelectorAll('button')];
    const prompts = [
      ['/files', '查看项目文件', '运行 list_files 工具'],
      ['/read README.md', '阅读项目说明', '运行 read_file 工具'],
      ['/search TODO', '搜索待办事项', '运行 search 工具'],
    ];
    suggestions.forEach((button, i) => {
      button.dataset.prompt = prompts[i][0];
      button.querySelector('strong').textContent = prompts[i][1];
      button.querySelector('span:not(.suggestion-icon):not(.suggestion-arrow)').textContent = prompts[i][2];
    });
    text('composer-caption', '离线 Demo 仅支持 /files、/read、/search 等命令，不理解任意自然语言。');
  } else {
    $('composer-caption').replaceChildren('Shift + Enter 换行 ', node('span', '', '·'), ' 工具在服务端配置的工作区中运行');
  }
}
function renderSessions() {
  text('session-count', String(state.sessions.length).padStart(2, '0'));
  const list = $('session-list');
  list.replaceChildren();
  if (!state.sessions.length) list.append(node('p', 'sidebar-empty', '从一个问题开始。'));
  for (const session of state.sessions) {
    const button = node('button', `session-item${session.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button';
    button.title = session.title || session.id;
    if (session.id === state.selectedId) button.setAttribute('aria-current', 'page');
    button.append(node('span', '', '◷'), node('span', '', session.title || '新会话'));
    if (session.updatedAt) {
      const time = new Date(session.updatedAt);
      if (!Number.isNaN(time.getTime())) {
        const display = time.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
        button.append(node('time', '', display));
      }
    }
    button.addEventListener('click', () => { void selectSession(session.id); closeMobileNav(); });
    list.append(button);
  }
  text('session-title', state.sessions.find(s => s.id === state.selectedId)?.title || '新会话');
  text('current-session-id', state.selectedId || '尚未建立会话');
  $('copy-session-id').disabled = !state.selectedId;
}
function mergeSession(session) {
  const index = state.sessions.findIndex(item => item.id === session.id);
  if (index < 0) state.sessions.unshift(session);
  else state.sessions[index] = session;
  state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renderSessions();
}
async function refreshSessions() {
  const client = state.client, auth = state.authGeneration;
  try {
    const sessions = await client.sessions();
    if (client !== state.client || auth !== state.authGeneration) return;
    state.sessions = sessions;
    renderSessions();
  } catch { /* The stream's connection indicator owns transport errors. */ }
}
function isRunning() { return state.turn?.status === 'running'; }
function renderControls() {
  const connected = state.connected && state.connection === 'live';
  const busy = isRunning() || state.submitting;
  $('message-input').disabled = !state.connected;
  $('send-message').disabled = !connected || busy || !$('message-input').value.trim();
  $('send-message').hidden = isRunning();
  $('cancel-turn').hidden = !isRunning();
  $('cancel-turn').disabled = state.cancelling || !connected;
  $('new-session').disabled = !state.connected || state.creating;
  $('open-settings').disabled = !state.connected || state.settingsBusy;
  $('message-input').placeholder = isRunning() ? 'Agent 正在执行；可先写下下一条消息…' : '描述你的任务，或问一个关于代码的问题…';
}
function currentTurnEvents() {
  const start = state.events.findLastIndex(event => event.type === 'turn.started');
  return state.events.slice(Math.max(0, start));
}
function renderInspector() {
  const events = currentTurnEvents();
  const running = isRunning();
  const waiting = state.approvals.length > 0;
  const status = state.turn?.status;
  const statusInfo = waiting ? ['等待你的审批', '确认工具操作后，Agent 将继续执行。', '◇']
    : running ? ['正在执行', 'Agent 正在分析任务并调用工具。', '◌']
    : status === 'completed' ? ['执行完成', '本回合已完成，可以继续对话。', '✓']
    : status === 'cancelled' ? ['已停止', '本回合已取消，已有记录仍然保留。', '■']
    : status === 'failed' ? ['执行失败', '查看对话中的错误信息后再试。', '!']
    : ['准备就绪', '发送任务后，执行过程会显示在这里。', '◌'];
  text('run-status', statusInfo[0]);
  text('run-description', statusInfo[1]);
  text('run-status-symbol', statusInfo[2]);
  $('run-status-symbol').className = `run-status-symbol${running && !waiting ? ' running' : ''}`;
  text('model-count', String(events.filter(e => e.type === 'model.start').length));
  text('tool-count', String(events.filter(e => e.type === 'tool.start').length));
  const timeline = [];
  for (const event of events) {
    if (event.type === 'turn.started') timeline.push(['任务开始', 'turn.started']);
    if (event.type === 'model.start') timeline.push([`模型步骤 ${Number(event.step) + 1}`, 'model.start']);
    if (event.type === 'tool.start') timeline.push([event.name, 'tool.start']);
    if (event.type === 'files.changed') timeline.push(['文件已修改', (event.paths || []).join(', ')]);
    if (event.type === 'context.trimmed') timeline.push(['已精简旧轮次', 'context.trimmed']);
    if (event.type === 'turn.completed') timeline.push(['本回合完成', 'turn.completed']);
    if (event.type === 'turn.cancelled') timeline.push(['本回合已取消', 'turn.cancelled']);
    if (event.type === 'turn.failed') timeline.push(['本回合失败', 'turn.failed']);
  }
  const list = $('activity-list');
  list.replaceChildren();
  if (!timeline.length) list.append(node('li', 'activity-placeholder', '还没有执行记录'));
  for (const [label, detail] of timeline.slice(-6)) {
    const item = node('li', '', label);
    item.append(node('small', '', detail));
    list.append(item);
  }
}
function renderRichText(container, content) {
  // Parse fenced code only. All model- and tool-provided text goes through textContent.
  const parts = String(content).split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('```') && part.endsWith('```')) {
      const pre = node('pre', 'code-block');
      pre.append(node('code', '', part.slice(part.indexOf('\n') + 1, -3).replace(/\n$/, '')));
      container.append(pre);
    } else container.append(node('span', '', part));
  }
}
function messageElement(role, content, streaming = false) {
  const item = node('article', `message ${role}`);
  item.append(node('div', `message-avatar${role === 'assistant' ? ' agent-avatar' : ''}`, role === 'assistant' ? 'k' : '你'));
  const body = node('div', 'message-content');
  body.append(node('span', 'message-label', role === 'assistant' ? 'Kraken' : '你'));
  const prose = node('div', `message-text${streaming ? ' streaming-text' : ''}`);
  renderRichText(prose, content);
  body.append(prose);
  item.append(body);
  return item;
}
function pretty(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2) ?? '';
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
function buildItems() {
  const items = [], tools = new Map();
  function getTool(id, name) {
    if (tools.has(id)) return tools.get(id);
    const tool = { type: 'tool', id, name: name || 'tool', args: '', result: null, status: 'pending' };
    tools.set(id, tool); items.push(tool); return tool;
  }
  for (const [index, event] of state.events.entries()) {
    if (event.type === 'message') {
      const message = event.message;
      if (!message) continue;
      if (message.role === 'user') items.push({ type: 'message', role: 'user', content: message.content });
      if (message.role === 'assistant') {
        if (message.reasoningContent?.trim()) items.push({ type: 'reasoning', id: index, content: message.reasoningContent });
        if (message.content) items.push({ type: 'message', role: 'assistant', content: message.content });
        for (const call of message.toolCalls || []) {
          const tool = getTool(call.id, call.name); tool.name = call.name; tool.args = call.arguments;
        }
      }
      if (message.role === 'tool') {
        const tool = getTool(message.toolCallId);
        tool.result = message.content;
        try { tool.status = JSON.parse(message.content).ok === false ? 'failed' : 'completed'; }
        catch { tool.status = 'completed'; }
      }
    }
    if (event.type === 'tool.start') getTool(event.callId, event.name).status = 'running';
    if (event.type === 'tool.end') getTool(event.callId, event.name).status = event.ok ? 'completed' : 'failed';
    if (event.type === 'turn.failed') items.push({ type: 'notice', error: true, content: `执行失败：${event.error || '未知错误'}` });
    if (event.type === 'turn.cancelled') items.push({ type: 'notice', content: '本回合已停止。你可以发送新的消息继续。' });
  }
  return items;
}
function reasoningElement(item) {
  const card = node('details', 'reasoning-card');
  card.open = item.streaming ? state.streamingReasoningOpen : state.expandedReasoning.has(item.id);
  const summary = node('summary');
  summary.append(node('span', 'tool-arrow', '›'), node('span', '', item.streaming && !state.delta ? '模型思考 · 生成中' : '模型思考'));
  summary.addEventListener('click', event => {
    event.preventDefault(); card.open = !card.open;
    if (item.streaming) state.streamingReasoningOpen = card.open;
    else if (card.open) state.expandedReasoning.add(item.id);
    else state.expandedReasoning.delete(item.id);
  });
  const body = node('div', 'reasoning-body');
  body.append(node('p', 'reasoning-caption', '模型接口返回的思考文本，不代表完整内部推理。'));
  const prose = node('div', 'message-text');
  renderRichText(prose, item.content);
  body.append(prose);
  card.append(summary, body);
  return card;
}
function toolElement(tool) {
  const card = node('details', 'tool-card');
  card.open = state.expandedTools.has(tool.id);
  card.addEventListener('toggle', () => {
    if (card.open) state.expandedTools.add(tool.id);
    else state.expandedTools.delete(tool.id);
  });
  const summary = node('summary');
  const labels = { pending: '待执行', running: isRunning() ? '执行中' : '未收到结果', completed: '已完成', failed: '未成功' };
  summary.append(node('span', 'tool-arrow', '›'), node('span', 'tool-name', tool.name), node('span', `tool-status ${tool.status}`, labels[tool.status]));
  card.append(summary);
  const body = node('div', 'tool-body');
  body.append(node('span', 'tool-label', `CALL ${tool.id || '—'}`));
  if (tool.args) body.append(node('span', 'tool-label', '参数'), node('pre', '', pretty(tool.args)));
  if (tool.result !== null) body.append(node('span', 'tool-label', '结果'), node('pre', '', pretty(tool.result)));
  card.append(body);
  return card;
}
function renderConversation() {
  const scroll = $('messages-scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const items = buildItems();
  $('welcome').hidden = items.length > 0 || !state.connected;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (item.type === 'message') fragment.append(messageElement(item.role, item.content));
    else if (item.type === 'reasoning') fragment.append(reasoningElement(item));
    else if (item.type === 'tool') fragment.append(toolElement(item));
    else fragment.append(node('div', `turn-notice${item.error ? ' error' : ''}`, item.content));
  }
  if (state.reasoningDelta) fragment.append(reasoningElement({ streaming: true, content: state.reasoningDelta }));
  if (state.delta) fragment.append(messageElement('assistant', state.delta, true));
  else if (isRunning() && !state.approvals.length && !state.reasoningDelta) {
    const thinking = node('div', 'thinking');
    thinking.append(node('span', 'thinking-dot'), 'Agent 正在处理…');
    fragment.append(thinking);
  }
  if (state.turn?.status === 'failed' && !state.events.some(e => e.type === 'turn.failed' && e.error === state.turn.error)) {
    fragment.append(node('div', 'turn-notice error', `执行失败：${state.turn.error || '请检查服务端日志'}`));
  }
  $('message-list').replaceChildren(fragment);
  if (atBottom) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  renderInspector();
  renderControls();
}
let conversationRenderQueued = false;
function scheduleConversationRender() {
  if (conversationRenderQueued) return;
  conversationRenderQueued = true;
  requestAnimationFrame(() => { conversationRenderQueued = false; renderConversation(); });
}
function renderApprovals() {
  const list = $('approval-list');
  list.replaceChildren();
  for (const approval of state.approvals) {
    const card = node('section', 'approval-card');
    const heading = node('div', 'approval-heading');
    heading.append(node('span', '', '◇'), `需要确认 · ${approval.name}`);
    card.append(heading, node('p', '', approval.effect === 'shell' ? '此命令将在本机执行，请核对后批准。' : '请检查以下操作内容，再决定是否继续。'), node('pre', 'approval-preview', approval.preview));
    const actions = node('div', 'approval-actions');
    for (const approved of [false, true]) {
      const button = node('button', '', approved ? '批准本次操作' : '拒绝');
      button.type = 'button';
      button.disabled = state.pendingApprovals.has(approval.id) || state.connection !== 'live';
      button.addEventListener('click', () => { void decideApproval(approval.id, approved); });
      actions.append(button);
    }
    card.append(actions); list.append(card);
  }
}
function render() { renderSessions(); renderConversation(); renderApprovals(); }
function consumeFrame(frame, generation) {
  if (generation !== state.generation) return;
  setConnection('live');
  if (frame.type === 'snapshot') {
    state.events = frame.snapshot.events;
    state.turn = frame.snapshot.turn;
    state.approvals = frame.snapshot.approvals;
    state.delta = ''; state.reasoningDelta = '';
    mergeSession(frame.snapshot.session);
    render();
    return;
  }
  if (frame.sessionId !== state.selectedId) return;
  if (frame.type === 'state') {
    state.turn = frame.turn;
    state.approvals = frame.approvals;
    if (frame.turn?.status !== 'running') {
      state.delta = ''; state.reasoningDelta = ''; state.cancelling = false;
      void refreshSessions();
    }
    render();
  } else if (frame.type === 'event') {
    if (frame.event.type === 'model.delta') {
      if (frame.event.channel === 'reasoning') state.reasoningDelta += frame.event.text || '';
      else state.delta += frame.event.text || '';
      scheduleConversationRender();
    } else {
      if (frame.event.type === 'message' && frame.event.message?.role === 'assistant' && state.reasoningDelta && state.streamingReasoningOpen) state.expandedReasoning.add(state.events.length);
      state.events.push(frame.event);
      if (frame.event.type === 'model.start' || (frame.event.type === 'message' && frame.event.message?.role === 'assistant')) {
        state.delta = ''; state.reasoningDelta = '';
        state.streamingReasoningOpen = true;
      }
      if (frame.event.type === 'message' && frame.event.message?.role === 'user') void refreshSessions();
      renderConversation();
    }
  }
}
async function streamSession(id, generation, controller) {
  let attempts = 0;
  while (!controller.signal.aborted && generation === state.generation) {
    try {
      await state.client.watchSession(id, frame => { attempts = 0; consumeFrame(frame, generation); }, controller.signal);
      if (controller.signal.aborted) return;
      throw new Error('事件连接已断开');
    } catch (error) {
      if (controller.signal.aborted || generation !== state.generation) return;
      if (error.status === 401 || error.status === 403) {
        controller.abort();
        requireConnection('连接令牌已失效或被服务端拒绝。请使用当前服务启动时显示的新链接或令牌重新连接。');
        return;
      }
      if (error.status === 404 || error.status === 409) {
        controller.abort();
        state.stream = null;
        const recovery = ++state.generation;
        state.selectedId = null; state.events = []; state.turn = null;
        state.approvals = []; state.delta = ''; state.reasoningDelta = ''; state.submitting = false; state.cancelling = false;
        state.pendingApprovals.clear(); state.expandedTools.clear(); state.expandedReasoning.clear();
        try { sessionStorage.removeItem(selectionKey); } catch { /* Optional preference. */ }
        showNotice('这个会话已不存在，或不属于当前工作区 / 模型。请选择其他会话，或新建会话。');
        setConnection('connecting'); render();
        try {
          const [info, sessions] = await Promise.all([state.client.info(), state.client.sessions()]);
          if (recovery !== state.generation) return;
          configure(info); state.sessions = sessions;
          setConnection('live'); render();
        } catch (refreshError) {
          if (recovery !== state.generation) return;
          requireConnection(`无法重新加载会话：${errorText(refreshError)}。请重新连接服务。`);
        }
        return;
      }
      setConnection('reconnecting');
      renderApprovals();
      if (attempts >= 2) showNotice('与 Agent Server 的连接已断开，正在重连。服务端任务会继续运行；重新连接后将恢复会话状态。');
      const delay = Math.min(8000, 1000 * 2 ** Math.min(attempts++, 3));
      await new Promise(resolve => {
        const timer = setTimeout(done, delay);
        function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }
        controller.signal.addEventListener('abort', done, { once: true });
      });
      if (!controller.signal.aborted && generation === state.generation) showNotice('');
    }
  }
}
function requireConnection(message) {
  ++state.generation;
  state.stream = null; state.connected = false;
  state.turn = null; state.approvals = []; state.delta = ''; state.reasoningDelta = '';
  state.submitting = false; state.cancelling = false;
  state.pendingApprovals.clear();
  $('connection-panel').hidden = false;
  text('connection-error', message);
  showNotice(''); setConnection('offline'); render();
  $('connection-token').focus();
}
async function selectSession(id) {
  if (id === state.selectedId && state.stream && !state.stream.signal.aborted) return;
  state.stream?.abort();
  const generation = ++state.generation;
  state.selectedId = id;
  state.events = []; state.turn = null; state.approvals = []; state.delta = ''; state.reasoningDelta = ''; state.streamingReasoningOpen = true;
  state.submitting = false; state.cancelling = false;
  state.pendingApprovals.clear(); state.expandedTools.clear(); state.expandedReasoning.clear();
  showNotice('');
  try { sessionStorage.setItem(selectionKey, id); } catch { /* Optional preference. */ }
  setConnection('connecting');
  render();
  const controller = new AbortController();
  state.stream = controller;
  void streamSession(id, generation, controller);
}
async function createSession() {
  if (!state.client || state.creating) return null;
  state.creating = true; renderControls();
  const auth = state.authGeneration, generation = state.generation;
  try {
    const session = await state.client.createSession();
    if (auth !== state.authGeneration) return null;
    mergeSession(session);
    if (generation !== state.generation) return null;
    await selectSession(session.id);
    closeMobileNav();
    $('message-input').focus();
    return session;
  } catch (error) {
    if (generation === state.generation && auth === state.authGeneration) showNotice(`无法新建会话：${errorText(error)}`);
    return null;
  } finally { if (auth === state.authGeneration) { state.creating = false; renderControls(); } }
}
async function sendMessage() {
  const input = $('message-input');
  const message = input.value.trim();
  if (!message || !state.client || state.submitting || isRunning() || state.connection !== 'live') return;
  let generation = state.generation;
  state.submitting = true; renderControls(); showNotice('');
  try {
    if (!state.selectedId) {
      const session = await createSession();
      if (!session) return;
      generation = state.generation;
      state.submitting = true;
    }
    const id = state.selectedId;
    const previousTurnId = state.turn?.id;
    const turn = await state.client.startTurn(id, message);
    if (generation !== state.generation) return;
    // The stream can finish before the command response arrives: do not rewind it.
    if (!state.turn || state.turn.id === previousTurnId || (state.turn.id === turn.id && state.turn.status === 'running')) state.turn = turn;
    if (input.value.trim() === message) input.value = '';
    resizeComposer(); render();
    $('messages-scroll').scrollTop = $('messages-scroll').scrollHeight;
  } catch (error) {
    if (generation === state.generation) {
      if (typeof error.status === 'number' && error.status < 500) showNotice(`发送未被接受：${errorText(error)}`);
      else showNotice(`未收到明确的发送结果：${errorText(error)}。请求可能已被服务端接收，请先检查当前会话和执行状态，再决定是否重试；页面不会自动重发。`);
    }
  } finally {
    if (generation === state.generation) { state.submitting = false; renderControls(); }
  }
}
async function cancelTurn() {
  if (!state.turn || state.cancelling || !isRunning()) return;
  const id = state.selectedId, turnId = state.turn.id, generation = state.generation;
  state.cancelling = true; renderControls();
  try { await state.client.cancelTurn(id, turnId); }
  catch (error) { if (generation === state.generation) showNotice(`停止失败：${errorText(error)}`); }
  finally { if (generation === state.generation) { state.cancelling = false; renderControls(); } }
}
async function decideApproval(id, approved) {
  if (state.pendingApprovals.has(id)) return;
  const generation = state.generation, session = state.selectedId;
  state.pendingApprovals.add(id); renderApprovals();
  try { await state.client.approve(session, id, approved); }
  catch (error) { if (generation === state.generation) showNotice(`审批未提交：${errorText(error)}`); }
  finally {
    if (generation === state.generation) { state.pendingApprovals.delete(id); renderApprovals(); }
  }
}
async function connect(token) {
  const auth = ++state.authGeneration;
  state.stream?.abort(); ++state.generation;
  state.connected = false; state.selectedId = null;
  state.events = []; state.turn = null; state.approvals = []; state.delta = ''; state.reasoningDelta = ''; state.streamingReasoningOpen = true;
  state.creating = false; state.submitting = false; state.cancelling = false;
  state.client = new AgentClient(location.origin, token);
  text('connection-error', ''); setConnection('connecting'); render();
  try {
    const [info, sessions] = await Promise.all([state.client.info(), state.client.sessions()]);
    if (auth !== state.authGeneration) return;
    configure(info); state.sessions = sessions; state.connected = true;
    try { sessionStorage.setItem(tokenKey, token); } catch { /* Session remains usable. */ }
    $('connection-panel').hidden = true;
    setConnection('live'); render();
    let selected;
    try { selected = sessionStorage.getItem(selectionKey); } catch { /* No saved selection. */ }
    if (sessions.some(session => session.id === selected)) await selectSession(selected);
    else if (sessions.length) await selectSession(sessions[0].id);
    $('message-input').focus();
  } catch (error) {
    if (auth !== state.authGeneration) return;
    state.connected = false;
    $('connection-panel').hidden = false;
    text('connection-error', `连接失败：${errorText(error)}`);
    setConnection('offline'); render();
  }
}
function closeMobileNav() { $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); }
function setSettingsBusy(busy) {
  state.settingsBusy = busy;
  for (const id of ['settings-request-timeout', 'settings-turn-timeout', 'save-settings']) $(id).disabled = busy;
  renderControls();
}
function settingsError(message = '') {
  text('settings-error', message); $('settings-error').hidden = !message;
}
async function openSettings() {
  if (!state.connected || state.settingsBusy) return;
  const client = state.client;
  $('settings-dialog').showModal(); settingsError(); setSettingsBusy(true);
  try {
    const limits = await client.settings();
    if (client !== state.client) return;
    $('settings-request-timeout').value = String(Number((limits.requestTimeoutMs / 60000).toFixed(6)));
    $('settings-turn-timeout').value = String(Number((limits.turnTimeoutMs / 3600000).toFixed(6)));
    configure({ ...state.info, ...limits });
  } catch (error) { settingsError(`无法加载设置：${errorText(error)}`); }
  finally { setSettingsBusy(false); }
}
async function saveSettings() {
  if (!state.connected || state.settingsBusy) return;
  const client = state.client;
  const limits = {
    requestTimeoutMs: Math.round(Number($('settings-request-timeout').value) * 60000),
    turnTimeoutMs: Math.round(Number($('settings-turn-timeout').value) * 3600000),
  };
  settingsError(); setSettingsBusy(true);
  try {
    const saved = await client.updateSettings(limits);
    if (client !== state.client) return;
    configure({ ...state.info, ...saved });
    $('settings-dialog').close();
    showNotice('运行设置已保存到 .env，从下一轮任务生效。');
  } catch (error) { settingsError(`保存失败：${errorText(error)}`); }
  finally { setSettingsBusy(false); }
}
function resizeComposer() {
  const input = $('message-input'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  renderControls();
}
$('composer-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
$('message-input').addEventListener('input', resizeComposer);
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendMessage(); }
});
$('new-session').addEventListener('click', () => { void createSession(); });
$('open-settings').addEventListener('click', () => { void openSettings(); });
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-form').addEventListener('submit', event => { event.preventDefault(); void saveSettings(); });
$('cancel-turn').addEventListener('click', () => { void cancelTurn(); });
$('copy-session-id').addEventListener('click', async () => {
  const id = state.selectedId;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    if (state.selectedId !== id) return;
    text('copy-session-id', '已复制');
    setTimeout(() => { text('copy-session-id', '复制'); }, 1800);
  } catch {
    if (state.selectedId !== id) return;
    const range = document.createRange();
    range.selectNodeContents($('current-session-id'));
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    showNotice('浏览器未允许自动复制，已选中会话 ID。可手动复制，并用于 CLI 的 --session 参数。');
  }
});
$('connect-form').addEventListener('submit', event => {
  event.preventDefault(); const token = $('connection-token').value.trim();
  if (token) { $('connection-token').value = ''; void connect(token); }
});
$('suggestions').addEventListener('click', event => {
  const button = event.target.closest('button[data-prompt]');
  if (!button) return;
  $('message-input').value = button.dataset.prompt; resizeComposer(); $('message-input').focus();
});
$('menu-toggle').addEventListener('click', () => {
  const open = $('sidebar').classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded', String(open));
});
$('inspector-toggle').addEventListener('click', () => {
  const inspector = $('inspector');
  if (matchMedia('(max-width:1000px)').matches) {
    const shown = inspector.classList.toggle('show-mobile'); $('inspector-toggle').setAttribute('aria-expanded', String(shown));
  } else { inspector.hidden = !inspector.hidden; $('inspector-toggle').setAttribute('aria-expanded', String(!inspector.hidden)); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); if (state.connected) void createSession();
  }
  if (event.key === 'Escape') { closeMobileNav(); $('inspector').classList.remove('show-mobile'); }
});
window.addEventListener('beforeunload', () => state.stream?.abort());
if (initialToken) void connect(initialToken);
else {
  $('connection-panel').hidden = false; $('welcome').hidden = true;
  setConnection('offline'); renderControls();
}
