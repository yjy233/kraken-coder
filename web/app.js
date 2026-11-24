import { AgentClient } from '/client.js';

const $ = id => document.getElementById(id);
const selectionKey = 'kraken.server.session';
const policyLabels = { ask: '每次问我', 'auto-review': '替我审批', 'full-auto': '完全权限', 'read-only': '只读模式', 'workspace-write': '工作区可写' };
const policyHelp = {
  ask: '修改文件或运行命令前请你确认。你可以记住常用命令。',
  'auto-review': '由当前模型单独审核补丁和命令。审核无法判断时交给你确认。',
  'full-auto': '直接应用补丁；启用 Shell 后，命令以你的本机用户身份执行。',
  'read-only': '只允许读取文件和更新计划。',
  'workspace-write': '直接应用工作区补丁，运行命令前请你确认。',
};
const state = {
  client: null, info: null, sessions: [], selectedId: null, events: [], turn: null, approvals: [], inputs: [],
  delta: '', reasoningDelta: '', stream: null, generation: 0, connected: false,
  submitting: false, creating: false, cancelling: false, settingsBusy: false, pendingApprovals: new Set(),
  connection: 'connecting', notice: '',
};
// Clean up credentials from bookmarks and tabs used by earlier versions.
if (location.hash.startsWith('#token=')) history.replaceState(null, '', location.pathname + location.search);
try { sessionStorage.removeItem('kraken.server.token'); } catch { /* Optional storage. */ }

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
  text('server-label', state.info ? `Agent Server · v${state.info.version}` : '正在连接…');
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
  text('permission-label', policyLabels[info.approval] || info.approval);
  text('config-provider', info.provider);
  text('config-mode', info.mode);
  text('config-approval', policyLabels[info.approval] || info.approval);
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
      button.querySelector('.suggestion-detail').textContent = prompts[i][2];
    });
    text('composer-caption', '离线 Demo 可用 /files、/read 或 /search。');
  }
  $('composer-caption').hidden = info.provider !== 'demo';
}
function renderSessions() {
  text('session-count', String(state.sessions.length));
  const list = $('session-list');
  list.replaceChildren();
  if (!state.sessions.length) list.append(node('p', 'sidebar-empty', '暂无会话'));
  for (const session of state.sessions) {
    const button = node('button', `session-item${session.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button';
    button.title = session.title || session.id;
    if (session.id === state.selectedId) button.setAttribute('aria-current', 'page');
    button.append($('session-icon').content.cloneNode(true), node('span', '', session.title || '新任务'));
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
  text('session-title', state.sessions.find(s => s.id === state.selectedId)?.title || '新任务');
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
  try {
    const sessions = await state.client.sessions();
    state.sessions = sessions;
    renderSessions();
  } catch { /* The stream's connection indicator owns transport errors. */ }
}
function isRunning() { return state.turn?.status === 'running'; }
function renderControls() {
  const connected = state.connected && state.connection === 'live';
  const running = isRunning(), hasMessage = Boolean($('message-input').value.trim());
  $('message-input').disabled = !state.connected;
  $('send-message').disabled = !connected || running || state.submitting || !hasMessage;
  $('send-message').hidden = running;
  $('send-hint').hidden = running;
  for (const id of ['steer-turn', 'follow-up-turn']) {
    $(id).hidden = !running;
    $(id).disabled = !connected || state.submitting || state.cancelling || !hasMessage;
  }
  $('resume-follow-ups').disabled = !connected || state.submitting;
  $('cancel-turn').hidden = !running;
  $('cancel-turn').disabled = state.cancelling || !connected;
  $('new-session').disabled = !state.connected || state.creating;
  $('top-new-session').disabled = $('new-session').disabled;
  $('open-settings').disabled = !state.connected || state.settingsBusy;
  $('composer-permission').disabled = $('open-settings').disabled;
  $('open-extensions').disabled = !state.connected;
  $('message-input').placeholder = running ? '补充要求，或排到下一轮…' : '发消息，或描述一个编程任务…';
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
    if (event.type === 'hook.end') timeline.push([`Hook · ${event.event}`, [event.source, event.status, event.message].filter(Boolean).join(' · ')]);
    if (event.type === 'extension.warning' || event.type === 'extension.diagnostic') timeline.push(['扩展提示', event.message]);
    if (event.type === 'approval.reviewing') timeline.push(['模型正在替你审批', event.name]);
    if (event.type === 'approval.result') {
      const label = event.source === 'rule' ? '命中已允许的命令'
        : event.source === 'reviewer' ? (event.approved ? '模型已批准' : '模型已拒绝')
        : event.commandPrefix ? '已记住命令规则' : (event.approved ? '你已批准' : '你已拒绝');
      timeline.push([label, event.commandPrefix || event.name]);
    }
    if (event.type === 'files.changed') timeline.push(['文件已修改', (event.paths || []).join(', ')]);
    if (event.type === 'context.trimmed') timeline.push([event.toolResults ? `已压缩 ${event.toolResults} 条工具结果` : '已精简旧轮次', 'context.trimmed']);
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
// Keep existing text and code nodes attached so selections and code scrollbars survive a delta.
function renderRichText(container, content) {
  const parts = content.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  let count = 0;
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    const code = index % 2 === 1;
    const value = code ? part.slice(part.indexOf('\n') + 1).replace(/\n?```$/, '') : part;
    let block = container.children[count++];
    if (block?.localName !== (code ? 'pre' : 'span')) {
      const next = code ? node('pre', 'code-block') : node('span');
      if (code) next.append(node('code'));
      if (block) block.replaceWith(next);
      else container.append(next);
      block = next;
    }
    const target = code ? block.firstChild : block;
    const textNode = target.firstChild;
    if (!textNode || !value.startsWith(textNode.data)) target.textContent = value;
    else if (value.length > textNode.length) textNode.appendData(value.slice(textNode.length));
  }
  while (container.children.length > count) container.lastElementChild.remove();
}
function messageElement(item) {
  const article = node('article', `message ${item.role}`);
  const assistant = item.role === 'assistant';
  article.append(node('div', `message-avatar${assistant ? ' agent-avatar' : ''}`, assistant ? 'k' : '你'));
  const body = node('div', 'message-content');
  body.append(node('span', 'message-label', assistant ? 'Kraken' : item.steered ? '你 · 调整任务' : '你'), node('div', 'message-text'));
  article.append(body);
  return article;
}
function pretty(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2) ?? '';
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
function buildItems(streamedReply) {
  let modelStart, submitted;
  const items = [], tools = new Map();
  function getTool(id, name) {
    if (tools.has(id)) return tools.get(id);
    const tool = { type: 'tool', id, name: name || 'tool', args: '', result: null, status: 'pending' };
    tools.set(id, tool); items.push(tool); return tool;
  }
  for (const [index, event] of state.events.entries()) {
    if (event.type === 'turn.started') submitted = undefined;
    if (event.type === 'turn.input') {
      submitted = event.content;
      items.push({ type: 'message', id: index, role: 'user', content: submitted });
    }
    if (event.type === 'turn.started' || event.type === 'model.start') modelStart = index;
    if (event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'turn.failed') modelStart = undefined;
    if (event.type === 'message') {
      const message = event.message;
      if (!message) continue;
      if (message.hookFeedback) items.push({ type: 'notice', id: index, content: message.content });
      else if (message.role === 'user') {
        if (message.steered || message.content !== submitted) {
          items.push({ type: 'message', id: index, role: 'user', content: message.content, steered: message.steered });
        }
        submitted = undefined;
      }
      if (message.role === 'assistant') {
        const id = modelStart ?? index;
        modelStart = undefined;
        if (message.reasoningContent?.trim()) items.push({ type: 'reasoning', id, content: message.reasoningContent, open: message === streamedReply });
        if (message.content) items.push({ type: 'message', id, role: 'assistant', content: message.content });
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
    if (event.type === 'turn.failed') items.push({ type: 'notice', id: index, error: true, content: `执行失败：${event.error || '未知错误'}` });
    if (event.type === 'turn.cancelled') items.push({ type: 'notice', id: index, content: '本回合已停止。你可以发送新的消息继续。' });
  }
  return { items, nextReplyId: modelStart };
}
function reasoningElement(item) {
  const card = node('details', 'reasoning-card');
  card.open = Boolean(item.open);
  const summary = node('summary');
  summary.append(node('span', 'tool-arrow', '›'), node('span'));
  const body = node('div', 'reasoning-body');
  body.append(node('p', 'reasoning-caption', '模型接口返回的思考文本，不代表完整内部推理。'), node('div', 'message-text'));
  card.append(summary, body);
  return card;
}
function toolElement(tool) {
  const card = node('details', 'tool-card');
  const summary = node('summary');
  summary.append(node('span', 'tool-arrow', '›'), node('span', 'tool-name', tool.name), node('span', 'tool-status'));
  const body = node('div', 'tool-body');
  body.append(node('span', 'tool-label', `CALL ${tool.id || '—'}`));
  card.append(summary, body);
  return card;
}
function updateTool(card, tool, previous) {
  const labels = { pending: '待执行', running: isRunning() ? '执行中' : '未收到结果', completed: '已完成', failed: '未成功' };
  const status = card.querySelector('.tool-status');
  if (status.textContent !== labels[tool.status]) {
    status.className = `tool-status ${tool.status}`;
    status.textContent = labels[tool.status];
  }
  if (tool.name !== previous?.name) card.querySelector('.tool-name').textContent = tool.name;
  const body = card.querySelector('.tool-body');
  for (const [field, label] of [['args', '参数'], ['result', '结果']]) {
    if (!tool[field] || tool[field] === previous?.[field]) continue;
    let pre = body.querySelector(`.${field}`);
    if (!pre) { pre = node('pre', field); body.append(node('span', 'tool-label', label), pre); }
    pre.textContent = pretty(tool[field]);
  }
}
const atBottom = el => el.scrollHeight - el.clientHeight - el.scrollTop <= 1;
const transcript = $('messages-scroll');
let readingPanel = null;
transcript.addEventListener('scroll', ({ target }) => {
  if (target === transcript) readingPanel = null;
  else if (target.matches('.reasoning-body, .tool-body pre')) {
    if (!atBottom(target)) readingPanel = target;
    else if (readingPanel === target) readingPanel = null;
  }
}, true);

const rows = [];
let historyLength = 0, nextReplyId;
function liveItems() {
  const items = [], id = nextReplyId ?? state.events.length;
  if (state.reasoningDelta) items.push({ type: 'reasoning', id, content: state.reasoningDelta, open: true, generating: !state.delta });
  if (state.delta) items.push({ type: 'message', id, role: 'assistant', content: state.delta, streaming: true });
  else if (isRunning() && nextReplyId !== undefined && !state.approvals.length && !state.reasoningDelta) items.push({ type: 'thinking' });
  if (state.turn?.status === 'failed' && !state.events.some(e => e.type === 'turn.failed' && e.error === state.turn.error)) {
    items.push({ type: 'notice', error: true, content: `执行失败：${state.turn.error || '请检查服务端日志'}` });
  }
  return items;
}
function createRow(item) {
  if (item.type === 'reasoning') return reasoningElement(item);
  if (item.type === 'message') return messageElement(item);
  if (item.type === 'tool') return toolElement(item);
  if (item.type === 'thinking') {
    const thinking = node('div', 'thinking');
    thinking.append(node('span', 'thinking-dot'), 'Agent 正在处理…');
    return thinking;
  }
  return node('div', `turn-notice${item.error ? ' error' : ''}`, item.content);
}
function updateProse(element, item, previous) {
  const prose = element.querySelector('.message-text');
  if (item.content !== previous?.content) {
    const body = item.type === 'reasoning' && element.querySelector('.reasoning-body');
    const follow = body && element.open && atBottom(body);
    renderRichText(prose, item.content);
    if (follow) body.scrollTop = body.scrollHeight;
  }
  if (item.type === 'reasoning' && (!previous || item.generating !== previous.generating)) {
    element.querySelector('summary span:last-child').textContent = item.generating ? '模型思考 · 生成中' : '模型思考';
  }
  if (item.type === 'message' && item.streaming !== previous?.streaming) {
    prose.classList.toggle('streaming-text', Boolean(item.streaming));
  }
}
// History grows by appending events. A streaming reply keeps its slot and ID when committed.
function renderRows(items, start = 0) {
  const follow = atBottom(transcript) && !(readingPanel?.clientHeight && !atBottom(readingPanel));
  const list = $('message-list');
  let index = start;
  for (const item of items) {
    const row = rows[index];
    let previous = row?.item, element = row?.element;
    if (!previous || previous.type !== item.type || previous.id !== item.id || previous.role !== item.role) {
      element = createRow(item);
      if (row) row.element.replaceWith(element);
      else list.append(element);
      previous = undefined;
    }
    if (item.type === 'message' || item.type === 'reasoning') updateProse(element, item, previous);
    else if (item.type === 'tool') updateTool(element, item, previous);
    else if (item.type === 'notice' && previous && item.content !== previous.content) element.textContent = item.content;
    rows[index++] = { item, element };
  }
  while (rows.length > index) rows.pop().element.remove();
  if (!readingPanel?.isConnected) readingPanel = null;
  if (follow && !atBottom(transcript)) transcript.scrollTop = transcript.scrollHeight;
}
function renderConversation(streamedReply) {
  const history = buildItems(streamedReply);
  historyLength = history.items.length;
  nextReplyId = history.nextReplyId;
  $('welcome').hidden = historyLength > 0 || !state.connected;
  renderRows([...history.items, ...liveItems()]);
  renderInspector();
  renderControls();
}
let conversationRenderQueued = false;
function scheduleConversationRender() {
  if (conversationRenderQueued) return;
  conversationRenderQueued = true;
  requestAnimationFrame(() => { conversationRenderQueued = false; renderRows(liveItems(), historyLength); });
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
    const choices = [['拒绝', false, false]];
    if (approval.commandPrefix) {
      const script = approval.commandPrefix.startsWith('npm ');
      card.append(node('p', '', script ? '记住后会运行此工作区当时定义的同名脚本。' : '记住后也会允许此命令的常用显示参数。'));
      choices.push([`此工作区以后允许「${approval.commandPrefix}」`, true, true]);
    }
    choices.push(['批准本次操作', true, false]);
    for (const [label, approved, remember] of choices) {
      const button = node('button', '', label);
      button.type = 'button';
      button.disabled = state.pendingApprovals.has(approval.id) || state.connection !== 'live';
      button.addEventListener('click', () => { void decideApproval(approval.id, approved, remember); });
      actions.append(button);
    }
    card.append(actions); list.append(card);
  }
}
function renderQueue() {
  $('input-queue').hidden = !state.inputs.length;
  $('resume-follow-ups').hidden = isRunning() || !state.inputs.some(item => item.kind === 'follow_up');
  const rows = state.inputs.map(item => {
    const row = node('li', 'queued-input');
    const status = item.kind === 'follow_up' ? '下一轮' : isRunning() && item.turnId === state.turn.id ? '待调整' : '未送达';
    const remove = node('button', 'queue-button', '移除');
    remove.type = 'button';
    remove.disabled = state.connection !== 'live';
    remove.addEventListener('click', () => { void removeInput(item.id); });
    row.append(node('span', 'queued-input-kind', status), node('span', 'queued-input-text', item.message), remove);
    return row;
  });
  $('queued-inputs').replaceChildren(...rows);
}
function render() { renderSessions(); renderConversation(); renderApprovals(); renderQueue(); }
function consumeFrame(frame, generation) {
  if (generation !== state.generation) return;
  if (state.connection !== 'live') setConnection('live');
  if (frame.type === 'snapshot') {
    state.events = frame.snapshot.events;
    state.turn = frame.snapshot.turn;
    state.approvals = frame.snapshot.approvals;
    state.inputs = frame.snapshot.inputs ?? [];
    state.delta = ''; state.reasoningDelta = '';
    mergeSession(frame.snapshot.session);
    render();
    return;
  }
  if (frame.sessionId !== state.selectedId) return;
  if (frame.type === 'state') {
    state.turn = frame.turn;
    state.approvals = frame.approvals;
    state.inputs = frame.inputs ?? [];
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
      const reply = frame.event.type === 'message' && frame.event.message?.role === 'assistant' ? frame.event.message : undefined;
      const streamedReply = state.reasoningDelta ? reply : undefined;
      state.events.push(frame.event);
      if (frame.event.type === 'model.start' || reply) {
        state.delta = ''; state.reasoningDelta = '';
      }
      if (frame.event.type === 'message' && frame.event.message?.role === 'user') void refreshSessions();
      renderConversation(streamedReply);
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
        disconnect('本机服务拒绝了连接。请从服务启动时显示的本机地址打开控制台。');
        return;
      }
      if (error.status === 404 || error.status === 409) {
        controller.abort();
        state.stream = null;
        const recovery = ++state.generation;
        state.selectedId = null; state.events = []; state.turn = null;
        state.approvals = []; state.inputs = []; state.delta = ''; state.reasoningDelta = ''; state.submitting = false; state.cancelling = false;
        state.pendingApprovals.clear();
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
          disconnect(`无法重新加载会话：${errorText(refreshError)}。请刷新页面重试。`);
        }
        return;
      }
      setConnection('reconnecting');
      renderApprovals();
      renderQueue();
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
function disconnect(message) {
  state.stream?.abort(); ++state.generation;
  state.stream = null; state.connected = false;
  state.turn = null; state.approvals = []; state.inputs = []; state.delta = ''; state.reasoningDelta = '';
  state.submitting = false; state.cancelling = false;
  state.pendingApprovals.clear();
  showNotice(message); setConnection('offline'); render();
}
async function selectSession(id) {
  if (id === state.selectedId && state.stream && !state.stream.signal.aborted) return;
  state.stream?.abort();
  const generation = ++state.generation;
  state.selectedId = id;
  state.events = []; state.turn = null; state.approvals = []; state.inputs = []; state.delta = ''; state.reasoningDelta = '';
  state.submitting = false; state.cancelling = false;
  state.pendingApprovals.clear();
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
  const generation = state.generation;
  try {
    const session = await state.client.createSession();
    mergeSession(session);
    if (generation !== state.generation) return null;
    await selectSession(session.id);
    closeMobileNav();
    $('message-input').focus();
    return session;
  } catch (error) {
    if (generation === state.generation) showNotice(`无法新建会话：${errorText(error)}`);
    return null;
  } finally { state.creating = false; renderControls(); }
}
async function sendMessage(kind) {
  const input = $('message-input');
  const message = input.value.trim();
  if (!message || !state.client || state.submitting || state.cancelling || state.connection !== 'live' || Boolean(kind) !== isRunning()) return;
  let generation = state.generation;
  if (!kind) transcript.scrollTop = transcript.scrollHeight;
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
    if (kind) {
      await state.client.queueInput(id, previousTurnId, kind, message);
    } else {
      const turn = await state.client.startTurn(id, message);
      if (generation !== state.generation) return;
      // The stream can finish before the command response arrives: do not rewind it.
      if (!state.turn || state.turn.id === previousTurnId || (state.turn.id === turn.id && state.turn.status === 'running')) state.turn = turn;
    }
    if (generation !== state.generation) return;
    if (input.value.trim() === message) input.value = '';
    resizeComposer(); render();
  } catch (error) {
    if (generation === state.generation) {
      if (typeof error.status === 'number' && error.status < 500) showNotice(`发送未被接受：${errorText(error)}`);
      else showNotice(`未收到明确的发送结果：${errorText(error)}。请求可能已被服务端接收，请先检查当前会话和执行状态，再决定是否重试；页面不会自动重发。`);
    }
  } finally {
    if (generation === state.generation) { state.submitting = false; renderControls(); }
  }
}
async function removeInput(inputId) {
  const generation = state.generation;
  try { await state.client.removeInput(state.selectedId, inputId); }
  catch (error) { if (generation === state.generation) showNotice(`移除失败：${errorText(error)}`); }
}
async function resumeFollowUps() {
  if (isRunning() || state.submitting || state.connection !== 'live') return;
  const generation = state.generation;
  state.submitting = true; renderControls(); showNotice('');
  try { await state.client.resumeFollowUps(state.selectedId); }
  catch (error) { if (generation === state.generation) showNotice(`无法继续队列：${errorText(error)}`); }
  finally {
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
async function decideApproval(id, approved, remember) {
  if (state.pendingApprovals.has(id)) return;
  const generation = state.generation, session = state.selectedId;
  state.pendingApprovals.add(id); renderApprovals();
  try { await state.client.approve(session, id, approved, remember); }
  catch (error) { if (generation === state.generation) showNotice(`审批未提交：${errorText(error)}`); }
  finally {
    if (generation === state.generation) { state.pendingApprovals.delete(id); renderApprovals(); }
  }
}
async function connect() {
  setConnection('connecting'); render();
  try {
    state.client = new AgentClient(location.origin);
    const [info, sessions] = await Promise.all([state.client.info(), state.client.sessions()]);
    configure(info); state.sessions = sessions; state.connected = true;
    setConnection('live'); render();
    let selected;
    try { selected = sessionStorage.getItem(selectionKey); } catch { /* No saved selection. */ }
    if (sessions.some(session => session.id === selected)) await selectSession(selected);
    else if (sessions.length) await selectSession(sessions[0].id);
    $('message-input').focus();
  } catch (error) {
    disconnect(`连接失败：${errorText(error)}。确认本机服务已启动后，刷新页面重试。`);
  }
}
const mobileNav = matchMedia('(max-width: 720px)');
const floatingInspector = matchMedia('(max-width: 1000px)');
const shell = document.querySelector('.app-shell');
function syncPanels() {
  const navOpen = mobileNav.matches ? $('sidebar').classList.contains('open') : !shell.classList.contains('nav-collapsed');
  const detailsOpen = !$('inspector').hidden;
  $('menu-toggle').setAttribute('aria-expanded', String(navOpen));
  $('inspector-toggle').setAttribute('aria-expanded', String(detailsOpen));
  $('panel-backdrop').hidden = !(mobileNav.matches && navOpen || floatingInspector.matches && detailsOpen);
}
function closeMobileNav() { $('sidebar').classList.remove('open'); syncPanels(); }
function closePanels() {
  if (!$('inspector').hidden) {
    $('inspector').hidden = true;
    $('inspector-toggle').focus();
  } else if ($('sidebar').classList.contains('open')) {
    $('menu-toggle').focus();
  }
  closeMobileNav();
}
function setSettingsBusy(busy) {
  state.settingsBusy = busy;
  for (const id of ['settings-approval', 'settings-request-timeout', 'settings-turn-timeout', 'settings-context-ratio', 'settings-context-window', 'save-settings']) $(id).disabled = busy;
  renderControls();
}
function settingsError(message = '') {
  text('settings-error', message); $('settings-error').hidden = !message;
}
function describeApproval() {
  text('settings-approval-help', policyHelp[$('settings-approval').value]);
}
async function openSettings(focusApproval = false) {
  if (!state.connected || state.settingsBusy) return;
  const client = state.client;
  $('settings-approval-field').hidden = true;
  $('settings-dialog').showModal(); settingsError(); setSettingsBusy(true);
  try {
    const limits = await client.settings();
    if (client !== state.client) return;
    if (limits.approval) {
      const select = $('settings-approval');
      select.value = select.dataset.saved = limits.approval;
      $('settings-approval-field').hidden = false;
      describeApproval();
    }
    $('settings-request-timeout').value = String(Number((limits.requestTimeoutMs / 60000).toFixed(6)));
    $('settings-turn-timeout').value = String(Number((limits.turnTimeoutMs / 3600000).toFixed(6)));
    const budget = limits.contextBudget;
    $('settings-context').hidden = !budget;
    if (budget) {
      $('settings-context-ratio').value = String(Number((limits.contextCompactRatio * 100).toFixed(6)));
      $('settings-context-window').value = limits.contextWindowTokens ?? '';
      const format = value => value.toLocaleString('zh-CN');
      text('settings-context-budget', budget.source === 'fallback'
        ? `当前按 ${format(budget.thresholdChars)} 字符压缩。探测到窗口或手动填写后会使用比例。`
        : `${budget.source === 'api' ? '接口返回' : '手动配置'}窗口 ${format(budget.windowTokens)} token，当前阈值约 ${format(budget.thresholdTokens)} token。`);
    }
    configure({ ...state.info, ...limits });
  } catch (error) { settingsError(`无法加载设置：${errorText(error)}`); }
  finally {
    setSettingsBusy(false);
    if (focusApproval && !$('settings-approval-field').hidden) $('settings-approval').focus();
  }
}
async function saveSettings() {
  if (!state.connected || state.settingsBusy) return;
  const client = state.client;
  const limits = {
    requestTimeoutMs: Math.round(Number($('settings-request-timeout').value) * 60000),
    turnTimeoutMs: Math.round(Number($('settings-turn-timeout').value) * 3600000),
  };
  const select = $('settings-approval');
  if (!$('settings-approval-field').hidden && select.value !== select.dataset.saved) limits.approval = select.value;
  if (!$('settings-context').hidden) {
    const window = $('settings-context-window').value;
    limits.contextWindowTokens = window === '' ? null : Number(window);
    limits.contextCompactRatio = Number($('settings-context-ratio').value) / 100;
  }
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
async function openExtensions() {
  const dialog = $('extensions-dialog'), list = $('extension-list'), client = state.client;
  if (!client || dialog.open) return;
  dialog.showModal();
  list.textContent = '正在读取扩展…';
  try {
    const catalog = await client.extensions();
    if (client !== state.client || !dialog.open) return;
    list.replaceChildren();
    list.append(node('h3', '', '可用技能'));
    if (!catalog.skills.length) list.append(node('p', '', '将 SKILL.md 放在工作区的 .agents/skills/<名称>/ 中，或在 config.json 中启用插件。'));
    for (const skill of catalog.skills) {
      const button = node('button', 'skill-choice');
      button.type = 'button';
      button.append(node('strong', '', skill.name), node('span', '', skill.description));
      button.addEventListener('click', () => {
        dialog.close();
        const input = $('message-input'), start = input.selectionStart, end = input.selectionEnd;
        const gap = start && !/\s/.test(input.value[start - 1]) ? ' ' : '';
        input.setRangeText(gap + '$' + skill.name + ' ', start, end, 'end');
        resizeComposer();
        input.focus();
      });
      list.append(button);
    }
    if (catalog.plugins.length) list.append(node('h3', '', '已启用插件'));
    for (const plugin of catalog.plugins) {
      const row = node('div', 'plugin-details');
      row.append(node('strong', '', plugin.name + (plugin.version ? ' · ' + plugin.version : '')));
      if (plugin.description) row.append(node('span', '', plugin.description));
      if (plugin.hookEvents.length) row.append(node('span', '', 'Hooks · ' + plugin.hookEvents.join('、')));
      if (plugin.mcpServers.length) row.append(node('span', '', 'MCP · ' + plugin.mcpServers.join('、')));
      list.append(row);
    }
    const standalone = catalog.hooks.filter(hook => !catalog.plugins.some(plugin => plugin.name === hook.source));
    if (standalone.length) {
      list.append(node('h3', '', '独立 Hooks'));
      for (const hook of standalone) list.append(node('p', '', hook.event + ' · ' + hook.source));
    }
    for (const warning of catalog.diagnostics) list.append(node('p', 'settings-error', warning));
  } catch (error) { list.textContent = '无法读取扩展。' + errorText(error); }
}
$('open-extensions').addEventListener('click', () => { void openExtensions(); });
$('composer-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
$('message-input').addEventListener('input', resizeComposer);
$('message-input').addEventListener('keydown', event => {
  // Some browsers end composition before dispatching its confirming Enter.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void sendMessage(isRunning() ? 'steer' : undefined);
});
$('steer-turn').addEventListener('click', () => { void sendMessage('steer'); });
$('follow-up-turn').addEventListener('click', () => { void sendMessage('follow_up'); });
$('resume-follow-ups').addEventListener('click', () => { void resumeFollowUps(); });
$('new-session').addEventListener('click', () => { void createSession(); });
$('top-new-session').addEventListener('click', () => { void createSession(); });
$('open-settings').addEventListener('click', () => { closeMobileNav(); void openSettings(); });
$('composer-permission').addEventListener('click', () => { void openSettings(true); });
$('settings-approval').addEventListener('change', describeApproval);
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
$('suggestions').addEventListener('click', event => {
  const button = event.target.closest('button[data-prompt]');
  if (!button) return;
  $('message-input').value = button.dataset.prompt; resizeComposer(); $('message-input').focus();
});
$('menu-toggle').addEventListener('click', () => {
  if (mobileNav.matches) {
    $('inspector').hidden = true;
    $('sidebar').classList.toggle('open');
  } else { shell.classList.toggle('nav-collapsed'); }
  syncPanels();
});
$('inspector-toggle').addEventListener('click', () => {
  const inspector = $('inspector');
  inspector.hidden = !inspector.hidden;
  closeMobileNav();
  if (!inspector.hidden && floatingInspector.matches) $('close-inspector').focus();
});
$('close-inspector').addEventListener('click', closePanels);
$('panel-backdrop').addEventListener('click', closePanels);
mobileNav.addEventListener('change', closeMobileNav);
floatingInspector.addEventListener('change', syncPanels);
syncPanels();
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); if (state.connected) void createSession();
  }
  if (event.key === 'Escape' && !$('settings-dialog').open) closePanels();
});
window.addEventListener('beforeunload', () => state.stream?.abort());
void connect();
