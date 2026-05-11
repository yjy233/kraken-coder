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
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      white-space: pre-wrap;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .message.user {
      border-color: var(--vscode-focusBorder);
    }

    .message.tool {
      border-style: dashed;
      background: var(--vscode-sideBarSectionHeader-background);
    }

    .message.running {
      border-color: var(--vscode-progressBar-background);
    }

    .message.error {
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
    <div class="toolbar">
      <div class="title">Kraken Coder</div>
      <button class="secondary" id="configure" title="Configure model">Config</button>
      <button class="secondary" id="setKey" title="Set API key">Key</button>
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
    let busy = false;
    let progress = 'Thinking...';

    const messagesEl = document.getElementById('messages');
    const contextEl = document.getElementById('context');
    const changesEl = document.getElementById('changes');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const errorEl = document.getElementById('error');

    document.getElementById('configure').addEventListener('click', () => post({ type: 'config.open' }));
    document.getElementById('setKey').addEventListener('click', () => post({ type: 'secret.setApiKey' }));
    document.getElementById('clear').addEventListener('click', () => post({ type: 'session.clear' }));

    document.getElementById('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = inputEl.value.trim();
      if (!text || busy) {
        return;
      }
      inputEl.value = '';
      post({ type: 'chat.send', text });
    });

    inputEl.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        document.getElementById('composer').requestSubmit();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'session.updated') {
        session = message.session;
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
      renderChanges();
      renderContext();
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
        item.appendChild(label(messageLabel(message)));
        item.appendChild(text(message.content));
        if (message.status === 'running' && message.kind !== 'tool') {
          const cursor = document.createElement('span');
          cursor.className = 'cursor';
          cursor.textContent = '▌';
          item.appendChild(cursor);
        }
        messagesEl.appendChild(item);
      }

      if (busy && !messages.some((message) => message.status === 'running')) {
        const item = document.createElement('div');
        item.className = 'message assistant';
        item.appendChild(label('assistant'));
        item.appendChild(text(progress));
        messagesEl.appendChild(item);
      }
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

    function text(value) {
      const el = document.createElement('div');
      el.textContent = value;
      return el;
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
