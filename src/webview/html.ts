import * as vscode from 'vscode';

export function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Kraken Coder</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --chat-bubble-bg: #12372f;
      --chat-bubble-border: #1f5a4c;
      --chat-user-bg: #17483d;
      --chat-tool-bg: var(--vscode-sideBarSectionHeader-background);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }

    .session-panel {
      border-bottom: 1px solid var(--border);
      background: var(--vscode-sideBar-background);
      padding: 10px 10px 8px;
    }

    .session-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .session-heading {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }

    .icon-button {
      width: 26px;
      height: 26px;
      min-height: 26px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      border-radius: 4px;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent;
    }

    .icon-button:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground));
    }

    .session-list {
      display: grid;
      gap: 2px;
    }

    .session-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      padding: 4px 6px;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
    }

    .session-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .session-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .session-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      line-height: 1.35;
    }

    .session-meta {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
    }

    .session-delete {
      opacity: 0;
    }

    .session-item:hover .session-delete,
    .session-item.active .session-delete {
      opacity: 1;
    }

    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      background: var(--vscode-sideBar-background);
    }

    .title {
      flex: 1;
      min-width: 0;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button {
      border: 0;
      border-radius: 3px;
      color: var(--button-fg);
      background: var(--button-bg);
      padding: 5px 8px;
      font: inherit;
      cursor: pointer;
      min-height: 26px;
    }

    button:hover {
      background: var(--button-hover);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .main {
      overflow: auto;
      padding: 10px 8px 12px;
    }

    .section {
      margin-bottom: 14px;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin: 0 0 6px;
    }

    .message {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      margin-bottom: 10px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .message.user {
      align-items: flex-end;
    }

    .message-bubble {
      width: fit-content;
      max-width: min(92%, 720px);
      padding: 9px 10px;
      border: 1px solid var(--chat-bubble-border);
      border-radius: 8px;
      color: var(--vscode-foreground);
      background: var(--chat-bubble-bg);
      box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
    }

    .message.user .message-bubble {
      background: var(--chat-user-bg);
    }

    .markdown {
      white-space: normal;
    }

    .markdown > :first-child {
      margin-top: 0;
    }

    .markdown > :last-child {
      margin-bottom: 0;
    }

    .markdown p {
      margin: 0 0 8px;
    }

    .markdown h1,
    .markdown h2,
    .markdown h3,
    .markdown h4,
    .markdown h5,
    .markdown h6 {
      margin: 12px 0 6px;
      line-height: 1.25;
      font-weight: 600;
    }

    .markdown h1 {
      font-size: 1.35em;
    }

    .markdown h2 {
      font-size: 1.22em;
    }

    .markdown h3 {
      font-size: 1.12em;
    }

    .markdown h4,
    .markdown h5,
    .markdown h6 {
      font-size: 1em;
    }

    .markdown ul,
    .markdown ol {
      margin: 0 0 8px;
      padding-left: 20px;
    }

    .markdown li {
      margin: 2px 0;
    }

    .markdown blockquote {
      margin: 0 0 8px;
      padding: 2px 0 2px 10px;
      border-left: 3px solid var(--border);
      color: var(--muted);
    }

    .markdown pre {
      margin: 0 0 8px;
      padding: 8px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
    }

    .markdown code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      border-radius: 3px;
      padding: 1px 3px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
    }

    .markdown pre code {
      display: block;
      padding: 0;
      border-radius: 0;
      background: transparent;
      white-space: pre;
    }

    .markdown a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .markdown a:hover {
      text-decoration: underline;
    }

    .markdown img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 6px 0;
      border-radius: 4px;
    }

    .markdown table {
      width: 100%;
      margin: 0 0 8px;
      border-collapse: collapse;
      display: block;
      overflow-x: auto;
    }

    .markdown th,
    .markdown td {
      border: 1px solid var(--border);
      padding: 4px 6px;
      text-align: left;
      vertical-align: top;
    }

    .markdown th {
      font-weight: 600;
      background: var(--vscode-sideBarSectionHeader-background);
    }

    .markdown hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 10px 0;
    }

    .message.tool .message-bubble {
      border-style: dashed;
      background: var(--chat-tool-bg);
    }

    .tool-card {
      width: min(92%, 720px);
      border: 1px dashed var(--border);
      border-radius: 8px;
      background: var(--chat-tool-bg);
      overflow: hidden;
    }

    .tool-card[open] {
      border-color: var(--chat-bubble-border);
    }

    .tool-card.running {
      border-color: var(--vscode-progressBar-background);
    }

    .tool-card.error {
      border-color: var(--vscode-errorForeground);
    }

    .tool-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 6px 9px;
      cursor: pointer;
      list-style: none;
    }

    .tool-summary::-webkit-details-marker {
      display: none;
    }

    .tool-summary::before {
      content: '›';
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 16px;
      line-height: 1;
      transform: translateY(-1px);
    }

    .tool-card[open] .tool-summary::before {
      transform: rotate(90deg) translateX(-1px);
    }

    .tool-name {
      flex: 0 0 auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .tool-params {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .tool-body {
      border-top: 1px dashed var(--border);
      padding: 8px 9px;
    }

    .tool-status {
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .message.running .message-bubble {
      border-color: var(--vscode-progressBar-background);
    }

    .message.error .message-bubble {
      border-color: var(--vscode-errorForeground);
    }

    .role {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .empty {
      color: var(--muted);
      padding: 18px 4px;
      line-height: 1.45;
    }

    .context-item,
    .change-set {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      padding: 8px;
      margin-bottom: 8px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .row .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      color: var(--muted);
      font-size: 11px;
      margin-top: 4px;
    }

    .files {
      margin-top: 8px;
      display: grid;
      gap: 6px;
    }

    .file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      align-items: center;
    }

    .file-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .composer {
      border-top: 1px solid var(--border);
      padding: 8px;
      background: var(--vscode-sideBar-background);
    }

    textarea {
      width: 100%;
      min-height: 82px;
      max-height: 220px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font: inherit;
      line-height: 1.4;
    }

    .composer-actions {
      margin-top: 8px;
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }

    .error {
      color: var(--vscode-errorForeground);
      margin: 0 0 8px;
      white-space: pre-wrap;
    }

    .cursor {
      display: inline-block;
      margin-left: 1px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="session-panel">
      <div class="session-header">
        <div class="session-heading">Sessions</div>
        <button class="icon-button" id="newSession" title="New session" aria-label="New session">✎</button>
      </div>
      <div class="session-list" id="sessions"></div>
    </section>
    <div class="toolbar">
      <div class="title">Kraken Coder</div>
      <button class="secondary" id="configure" title="Configure model">Config</button>
      <button class="secondary" id="clear" title="Clear session">Clear</button>
    </div>
    <main class="main">
      <div id="error" class="error" hidden></div>
      <section class="section">
        <h2 class="section-header">Chat</h2>
        <div id="messages"></div>
      </section>
      <section class="section">
        <h2 class="section-header">Changes</h2>
        <div id="changes"></div>
      </section>
      <section class="section">
        <h2 class="section-header">Context</h2>
        <div id="context"></div>
      </section>
    </main>
    <form class="composer" id="composer">
      <textarea id="input" placeholder="Ask Kraken to explain, fix, or write code..."></textarea>
      <div class="composer-actions">
        <button type="submit" id="send">Send</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let session = undefined;
    let sessions = [];
    let busy = false;
    let progress = 'Thinking...';
    const openToolMessages = new Set();

    const messagesEl = document.getElementById('messages');
    const sessionsEl = document.getElementById('sessions');
    const contextEl = document.getElementById('context');
    const changesEl = document.getElementById('changes');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const errorEl = document.getElementById('error');

    document.getElementById('configure').addEventListener('click', () => post({ type: 'config.open' }));
    document.getElementById('clear').addEventListener('click', () => post({ type: 'session.clear' }));
    document.getElementById('newSession').addEventListener('click', () => post({ type: 'session.new' }));

    document.getElementById('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      sendCurrentMessage();
    });

    inputEl.addEventListener('keydown', (event) => {
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      if ((event.metaKey || event.ctrlKey) && isEnter) {
        event.preventDefault();
        sendCurrentMessage();
      }
    });

    function sendCurrentMessage() {
      const text = inputEl.value.trim();
      if (!text || busy) {
        return;
      }
      inputEl.value = '';
      post({ type: 'chat.send', text });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'session.updated') {
        session = message.session;
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        busy = Boolean(session.busy);
        if (!busy) {
          progress = 'Thinking...';
        }
        render();
      }
      if (message.type === 'agent.progress') {
        progress = message.message || 'Thinking...';
        errorEl.hidden = true;
        renderMessages();
      }
      if (message.type === 'error') {
        errorEl.textContent = message.message;
        errorEl.hidden = false;
      }
    });

    function post(message) {
      vscode.postMessage(message);
    }

    function render() {
      sendEl.disabled = busy;
      inputEl.disabled = busy;
      renderMessages();
      renderSessions();
      renderChanges();
      renderContext();
    }

    function renderSessions() {
      const items = sessions.length ? sessions : (session ? [{
        id: session.id,
        title: session.title || 'New session',
        updatedAt: Date.now(),
        messageCount: session.messages?.length || 0
      }] : []);

      sessionsEl.innerHTML = '';
      for (const item of items.slice(0, 6)) {
        const row = document.createElement('div');
        row.className = 'session-item' + (session && item.id === session.id ? ' active' : '');
        row.title = item.title;
        row.addEventListener('click', () => {
          if (!busy && (!session || item.id !== session.id)) {
            post({ type: 'session.switch', sessionId: item.id });
          }
        });

        const text = document.createElement('div');
        text.className = 'session-text';
        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = item.title || 'New session';
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = formatSessionMeta(item);
        text.append(title, meta);

        const remove = button('×', 'icon-button session-delete');
        remove.title = 'Delete session';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!busy) {
            post({ type: 'session.delete', sessionId: item.id });
          }
        });

        row.append(text, remove);
        sessionsEl.appendChild(row);
      }
    }

    function renderMessages() {
      const messages = session?.messages ?? [];
      if (!messages.length) {
        messagesEl.innerHTML = '<div class="empty">Start with a coding task, or select code and run a Kraken command from the editor context menu.</div>';
        return;
      }

      messagesEl.innerHTML = '';
      for (const message of messages) {
        const item = document.createElement('div');
        item.className = ['message', message.role, message.kind || '', message.status || ''].filter(Boolean).join(' ');
        if (message.kind === 'tool') {
          item.appendChild(toolCard(message));
          messagesEl.appendChild(item);
          continue;
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.appendChild(label(messageLabel(message)));
        bubble.appendChild(markdown(message.content));
        if (message.status === 'running' && message.kind !== 'tool') {
          const cursor = document.createElement('span');
          cursor.className = 'cursor';
          cursor.textContent = '▌';
          bubble.appendChild(cursor);
        }
        item.appendChild(bubble);
        messagesEl.appendChild(item);
      }

      if (busy && !messages.some((message) => message.status === 'running')) {
        const item = document.createElement('div');
        item.className = 'message assistant';
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.appendChild(label('assistant'));
        bubble.appendChild(markdown(progress));
        item.appendChild(bubble);
        messagesEl.appendChild(item);
      }
    }

    function formatSessionMeta(item) {
      const count = Number(item.messageCount || 0);
      const updatedAt = Number(item.updatedAt || 0);
      const parts = [count + ' msg' + (count === 1 ? '' : 's')];
      if (updatedAt) {
        parts.push(relativeTime(updatedAt));
      }
      return parts.join(' · ');
    }

    function relativeTime(value) {
      const diff = Math.max(0, Date.now() - value);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return 'now';
      if (diff < hour) return Math.floor(diff / minute) + 'm';
      if (diff < day) return Math.floor(diff / hour) + 'h';
      return Math.floor(diff / day) + 'd';
    }

    function renderContext() {
      const context = session?.context ?? [];
      if (!context.length) {
        contextEl.innerHTML = '<div class="empty">Context is collected from the active file, selection, diagnostics, and workspace tree when you send a task.</div>';
        return;
      }

      contextEl.innerHTML = '';
      for (const item of context) {
        const wrapper = document.createElement('div');
        wrapper.className = 'context-item';
        const row = document.createElement('div');
        row.className = 'row';
        const labelEl = document.createElement('div');
        labelEl.className = 'label';
        labelEl.textContent = item.label;
        const remove = button('Remove', 'secondary');
        remove.addEventListener('click', () => post({ type: 'context.remove', contextId: item.id }));
        row.append(labelEl, remove);
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = item.kind + ' · ' + item.content.length + ' chars';
        wrapper.append(row, meta);
        contextEl.appendChild(wrapper);
      }
    }

    function renderChanges() {
      const changes = session?.changeSets ?? [];
      if (!changes.length) {
        changesEl.innerHTML = '<div class="empty">Generated code changes will appear here for review before applying.</div>';
        return;
      }

      changesEl.innerHTML = '';
      for (const changeSet of changes) {
        const wrapper = document.createElement('div');
        wrapper.className = 'change-set';
        const row = document.createElement('div');
        row.className = 'row';
        const title = document.createElement('div');
        title.className = 'label';
        title.textContent = changeSet.title || 'Proposed changes';
        const apply = button('Apply');
        apply.addEventListener('click', () => post({ type: 'change.apply', changeSetId: changeSet.id }));
        const reject = button('Reject', 'secondary');
        reject.addEventListener('click', () => post({ type: 'change.reject', changeSetId: changeSet.id }));
        row.append(title, apply, reject);

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = changeSet.files.length + ' file(s)';

        const files = document.createElement('div');
        files.className = 'files';
        for (const file of changeSet.files) {
          const fileRow = document.createElement('div');
          fileRow.className = 'file-row';
          const filePath = document.createElement('div');
          filePath.className = 'file-path';
          filePath.textContent = file.status + ' · ' + file.path;
          const diff = button('Diff', 'secondary');
          diff.addEventListener('click', () => post({ type: 'change.openDiff', changeSetId: changeSet.id, filePath: file.path }));
          fileRow.append(filePath, diff);
          files.appendChild(fileRow);
        }

        wrapper.append(row, meta, files);
        changesEl.appendChild(wrapper);
      }
    }

    function label(value) {
      const el = document.createElement('span');
      el.className = 'role';
      el.textContent = value;
      return el;
    }

    function messageLabel(message) {
      if (message.kind === 'tool') {
        const status = message.status === 'error' ? 'error' : message.status === 'complete' ? 'done' : 'running';
        return 'tool · ' + (message.toolName || 'tool') + ' · ' + status;
      }
      return message.role + (message.status === 'running' ? ' · streaming' : '');
    }

    function toolCard(message) {
      const card = document.createElement('details');
      card.className = ['tool-card', message.status || ''].filter(Boolean).join(' ');
      const stateKey = toolStateKey(message);
      card.open = openToolMessages.has(stateKey);
      card.addEventListener('toggle', () => {
        if (card.open) {
          openToolMessages.add(stateKey);
        } else {
          openToolMessages.delete(stateKey);
        }
      });

      const summary = document.createElement('summary');
      summary.className = 'tool-summary';
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = message.toolName || 'tool';
      const params = document.createElement('span');
      params.className = 'tool-params';
      params.textContent = formatToolParams(message.metadata?.input);
      summary.append(name, params);

      const body = document.createElement('div');
      body.className = 'tool-body';
      const status = document.createElement('div');
      status.className = 'tool-status';
      status.textContent = message.status === 'error' ? 'error' : message.status === 'complete' ? 'complete' : 'running';
      body.appendChild(status);
      body.appendChild(markdown(message.content));

      card.append(summary, body);
      return card;
    }

    function toolStateKey(message) {
      return message.toolUseId || message.id || message.toolName || 'tool';
    }

    function formatToolParams(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return '{}';
      }
      const entries = Object.entries(input);
      if (!entries.length) {
        return '{}';
      }
      const text = entries.map(([key, value]) => key + '=' + formatToolValue(value)).join(' ');
      return text.length > 180 ? text.slice(0, 179) + '…' : text;
    }

    function formatToolValue(value) {
      if (typeof value === 'string') {
        return JSON.stringify(value.length > 60 ? value.slice(0, 59) + '…' : value);
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      if (value === null) {
        return 'null';
      }
      if (Array.isArray(value)) {
        return '[' + value.length + ']';
      }
      if (typeof value === 'object') {
        return '{' + Object.keys(value).slice(0, 3).join(',') + '}';
      }
      return String(value);
    }

    function markdown(value) {
      const el = document.createElement('div');
      el.className = 'markdown';
      renderMarkdownInto(el, String(value || ''));
      return el;
    }

    function renderMarkdownInto(container, source) {
      const lines = source.replace(/\\r\\n?/g, '\\n').split('\\n');
      const codeFence = String.fromCharCode(96, 96, 96);
      let index = 0;

      while (index < lines.length) {
        const line = lines[index];

        if (!line.trim()) {
          index += 1;
          continue;
        }

        const trimmedLine = line.trim();
        if (trimmedLine.startsWith(codeFence)) {
          const codeLines = [];
          const language = trimmedLine.slice(codeFence.length).trim();
          index += 1;
          while (index < lines.length && !lines[index].trim().startsWith(codeFence)) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) {
            index += 1;
          }
          container.appendChild(codeBlock(codeLines.join('\\n'), language));
          continue;
        }

        const heading = line.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          const level = heading[1].length;
          const el = document.createElement('h' + level);
          appendInlineMarkdown(el, heading[2]);
          container.appendChild(el);
          index += 1;
          continue;
        }

        if (/^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)/.test(line)) {
          const ordered = /^\\s*\\d+[.)]\\s+/.test(line);
          const list = document.createElement(ordered ? 'ol' : 'ul');
          while (index < lines.length && /^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)/.test(lines[index])) {
            const item = document.createElement('li');
            appendInlineMarkdown(item, lines[index].replace(/^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)/, ''));
            list.appendChild(item);
            index += 1;
          }
          container.appendChild(list);
          continue;
        }

        if (/^>\\s?/.test(line)) {
          const quote = document.createElement('blockquote');
          const quoteLines = [];
          while (index < lines.length && /^>\\s?/.test(lines[index])) {
            quoteLines.push(lines[index].replace(/^>\\s?/, ''));
            index += 1;
          }
          renderMarkdownInto(quote, quoteLines.join('\\n'));
          container.appendChild(quote);
          continue;
        }

        if (/^\\s*---+\\s*$/.test(line)) {
          container.appendChild(document.createElement('hr'));
          index += 1;
          continue;
        }

        if (isTableStart(lines, index)) {
          const tableLines = [lines[index], lines[index + 1]];
          index += 2;
          while (index < lines.length && /^\\s*\\|.*\\|\\s*$/.test(lines[index])) {
            tableLines.push(lines[index]);
            index += 1;
          }
          container.appendChild(table(tableLines));
          continue;
        }

        const paragraphLines = [line.trim()];
        index += 1;
        while (
          index < lines.length
          && lines[index].trim()
          && !lines[index].trim().startsWith(codeFence)
          && !/^(#{1,6})\\s+/.test(lines[index])
          && !/^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)/.test(lines[index])
          && !/^>\\s?/.test(lines[index])
          && !/^\\s*---+\\s*$/.test(lines[index])
          && !isTableStart(lines, index)
        ) {
          paragraphLines.push(lines[index].trim());
          index += 1;
        }

        const paragraph = document.createElement('p');
        appendInlineMarkdown(paragraph, paragraphLines.join(' '));
        container.appendChild(paragraph);
      }
    }

    function codeBlock(source, language) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (language.trim()) {
        code.dataset.language = language.trim();
      }
      code.textContent = source;
      pre.appendChild(code);
      return pre;
    }

    function appendInlineMarkdown(parent, source) {
      const tick = String.fromCharCode(96);
      const pattern = new RegExp('(!?\\\\[[^\\\\]]*\\\\]\\\\([^\\\\s)]+(?:\\\\s+"[^"]*")?\\\\)|' + tick + '[^' + tick + ']+' + tick + '|\\\\*\\\\*[^*]+\\\\*\\\\*|__[^_]+__|\\\\*[^*]+\\\\*|_[^_]+_)', 'g');
      let lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > lastIndex) {
          parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
        }
        parent.appendChild(inlineNode(match[0]));
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < source.length) {
        parent.appendChild(document.createTextNode(source.slice(lastIndex)));
      }
    }

    function inlineNode(token) {
      const tick = String.fromCharCode(96);
      if (token.startsWith(tick) && token.endsWith(tick)) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        return code;
      }

      const image = token.match(/^!\\[([^\\]]*)\\]\\(([^\\s)]+)(?:\\s+\"[^\"]*\")?\\)$/);
      if (image) {
        const src = sanitizeUrl(image[2], true);
        if (src) {
          const img = document.createElement('img');
          img.alt = image[1] || '';
          img.src = src;
          return img;
        }
      }

      const link = token.match(/^\\[([^\\]]*)\\]\\(([^\\s)]+)(?:\\s+\"[^\"]*\")?\\)$/);
      if (link) {
        const href = sanitizeUrl(link[2], false);
        if (href) {
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.textContent = link[1] || href;
          anchor.title = href;
          return anchor;
        }
      }

      if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        return strong;
      }

      if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
        const emphasis = document.createElement('em');
        emphasis.textContent = token.slice(1, -1);
        return emphasis;
      }

      return document.createTextNode(token);
    }

    function sanitizeUrl(url, image) {
      const value = String(url || '').trim();
      if (!value) {
        return '';
      }
      if (/^(https?:|data:image\\/|vscode-resource:|vscode-webview-resource:)/i.test(value)) {
        return value;
      }
      if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) {
        return value;
      }
      return image ? '' : '';
    }

    function isTableStart(lines, index) {
      return Boolean(
        lines[index]
        && lines[index + 1]
        && /^\\s*\\|.*\\|\\s*$/.test(lines[index])
        && /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(lines[index + 1])
      );
    }

    function table(lines) {
      const tableEl = document.createElement('table');
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');
      const headers = splitTableRow(lines[0]);
      const headRow = document.createElement('tr');
      for (const header of headers) {
        const th = document.createElement('th');
        appendInlineMarkdown(th, header);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);

      for (const line of lines.slice(2)) {
        const cells = splitTableRow(line);
        const row = document.createElement('tr');
        for (let index = 0; index < Math.max(headers.length, cells.length); index += 1) {
          const td = document.createElement('td');
          appendInlineMarkdown(td, cells[index] || '');
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }

      tableEl.append(thead, tbody);
      return tableEl;
    }

    function splitTableRow(line) {
      return line.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map((cell) => cell.trim());
    }

    function button(value, className) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = value;
      if (className) {
        el.className = className;
      }
      return el;
    }
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
