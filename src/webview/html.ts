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

    .tabs {
      display: flex;
      gap: 4px;
      margin: 0 0 10px;
      padding: 0 0 2px;
      border-bottom: 1px solid var(--border);
    }

    .tab-button {
      min-width: 0;
      padding: 5px 9px;
      border: 1px solid transparent;
      border-bottom-color: transparent;
      border-radius: 4px 4px 0 0;
      color: var(--muted);
      background: transparent;
    }

    .tab-button:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground));
    }

    .tab-button.active {
      color: var(--vscode-foreground);
      border-color: var(--border);
      border-bottom-color: var(--vscode-sideBar-background);
      background: var(--vscode-sideBar-background);
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

    .message.tool .message-bubble,
    .message.thinking .message-bubble {
      border-style: dashed;
      background: var(--chat-tool-bg);
    }

    .tool-card,
    .thinking-card {
      width: min(92%, 720px);
      border: 1px dashed var(--border);
      border-radius: 8px;
      background: var(--chat-tool-bg);
      overflow: hidden;
    }

    .tool-card[open],
    .thinking-card[open] {
      border-color: var(--chat-bubble-border);
    }

    .tool-card.running,
    .thinking-card.running {
      border-color: var(--vscode-progressBar-background);
    }

    .tool-card.error,
    .thinking-card.error {
      border-color: var(--vscode-errorForeground);
    }

    .tool-summary,
    .thinking-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 6px 9px;
      cursor: pointer;
      list-style: none;
    }

    .tool-summary::-webkit-details-marker,
    .thinking-summary::-webkit-details-marker {
      display: none;
    }

    .tool-summary::before,
    .thinking-summary::before {
      content: '›';
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 16px;
      line-height: 1;
      transform: translateY(-1px);
    }

    .tool-card[open] .tool-summary::before,
    .thinking-card[open] .thinking-summary::before {
      transform: rotate(90deg) translateX(-1px);
    }

    .tool-name,
    .thinking-name {
      flex: 0 0 auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .tool-params,
    .thinking-params {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .tool-body,
    .thinking-body {
      border-top: 1px dashed var(--border);
      padding: 8px 9px;
    }

    .tool-status,
    .thinking-status {
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .tool-section,
    .thinking-section {
      display: grid;
      gap: 5px;
      margin-top: 8px;
    }

    .tool-section:first-child,
    .thinking-section:first-child {
      margin-top: 0;
    }

    .tool-section-title,
    .thinking-section-title {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .tool-json,
    .thinking-text {
      margin: 0;
      padding: 8px;
      max-height: 320px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre;
    }

    .thinking-text {
      white-space: pre-wrap;
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
    .change-set,
    .usage-card,
    .usage-row {
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

    .usage-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 8px;
    }

    .usage-metric-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 2px;
    }

    .usage-metric-value {
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      font-weight: 600;
    }

    .usage-list {
      display: grid;
      gap: 8px;
    }

    .usage-row-header {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: space-between;
    }

    .usage-row-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-weight: 600;
    }

    .usage-badge {
      flex: 0 0 auto;
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
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

    .input-wrap {
      position: relative;
    }

    .slash-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 6px);
      max-height: 260px;
      overflow: auto;
      border: 1px solid var(--vscode-quickInputList-focusForeground, var(--border));
      border-radius: 6px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
      box-shadow: 0 4px 14px rgb(0 0 0 / 28%);
      padding: 4px;
      z-index: 10;
    }

    .slash-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      width: 100%;
      min-height: 42px;
      padding: 6px 8px;
      border-radius: 4px;
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      background: transparent;
      text-align: left;
    }

    .slash-item:hover,
    .slash-item.active {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-list-activeSelectionForeground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-activeSelectionBackground));
    }

    .slash-main {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .slash-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
    }

    .slash-description {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 11px;
    }

    .slash-kind {
      align-self: start;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      line-height: 1.4;
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

    .attachment-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 28px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-badge-background, var(--vscode-editorWidget-background));
      color: var(--vscode-foreground);
      font-size: 11px;
      line-height: 1.3;
    }

    .attachment-chip.image {
      padding-left: 4px;
    }

    .attachment-thumb {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      object-fit: cover;
      flex: 0 0 auto;
    }

    .attachment-meta {
      min-width: 0;
      display: grid;
      gap: 1px;
    }

    .attachment-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .attachment-info {
      color: var(--muted);
      font-size: 10px;
    }

    .attachment-remove {
      flex: 0 0 auto;
      min-width: 20px;
      min-height: 20px;
      padding: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
      font-size: 14px;
      line-height: 1;
    }

    .attachment-remove:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground));
    }

    .composer-actions {
      margin-top: 8px;
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-end;
    }

    .model-pill {
      flex: 1;
      min-width: 0;
      display: flex;
      justify-content: flex-end;
    }

    .model-pill button {
      max-width: 100%;
      min-height: 28px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 11px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-pill button:hover {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .send-button {
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      color: var(--vscode-editor-background);
      background: var(--vscode-foreground);
      font-size: 26px;
      line-height: 1;
    }

    .send-button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .send-button:disabled {
      opacity: 0.7;
    }

    .send-button.stop {
      font-size: 18px;
    }

    .attach-button {
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 20px;
      line-height: 1;
    }

    .attach-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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
      <div class="tabs" id="tabs">
        <button type="button" class="tab-button active" data-tab="chat">Chat</button>
        <button type="button" class="tab-button" data-tab="changes">Changes</button>
        <button type="button" class="tab-button" data-tab="context">Context</button>
        <button type="button" class="tab-button" data-tab="usage">Usage</button>
      </div>
      <section class="section" data-panel="chat">
        <h2 class="section-header">Chat</h2>
        <div id="messages"></div>
      </section>
      <section class="section" data-panel="changes" hidden>
        <h2 class="section-header">Changes</h2>
        <div id="changes"></div>
      </section>
      <section class="section" data-panel="context" hidden>
        <h2 class="section-header">Context</h2>
        <div id="context"></div>
      </section>
      <section class="section" data-panel="usage" hidden>
        <h2 class="section-header">Usage</h2>
        <div id="usage"></div>
      </section>
    </main>
    <form class="composer" id="composer">
      <div class="input-wrap">
        <div class="slash-menu" id="slashMenu" hidden></div>
      <textarea id="input" placeholder="Ask Kraken to explain, fix, or write code..."></textarea>
      </div>
      <div class="attachment-list" id="attachments"></div>
      <input id="attachmentInput" type="file" hidden multiple>
      <div class="composer-actions">
        <button class="attach-button" type="button" id="attach" title="Attach files" aria-label="Attach files">+</button>
        <div class="model-pill"><button type="button" id="modelInfo" title="Configure model">Model</button></div>
        <button class="send-button" type="submit" id="send" title="Send message" aria-label="Send message">↑</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let session = undefined;
    let sessions = [];
    let busy = false;
    let activeRunId = undefined;
    let queueLength = 0;
    let progress = 'Thinking...';
    let modelInfo = undefined;
    let activeTab = 'chat';
    let slashCompletionRequestId = 0;
    let slashCompletionItems = [];
    let slashCompletionActiveIndex = 0;
    const openToolMessages = new Set();
    const openThinkingMessages = new Set();

    const messagesEl = document.getElementById('messages');
    const sessionsEl = document.getElementById('sessions');
    const contextEl = document.getElementById('context');
    const changesEl = document.getElementById('changes');
    const usageEl = document.getElementById('usage');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const attachEl = document.getElementById('attach');
    const attachmentInputEl = document.getElementById('attachmentInput');
    const attachmentsEl = document.getElementById('attachments');
    const modelInfoEl = document.getElementById('modelInfo');
    const errorEl = document.getElementById('error');
    const slashMenuEl = document.getElementById('slashMenu');
    const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
    const panels = Array.from(document.querySelectorAll('[data-panel]'));
    let pendingAttachments = [];

    document.getElementById('configure').addEventListener('click', () => post({ type: 'config.open' }));
    modelInfoEl.addEventListener('click', () => post({ type: 'config.open' }));
    document.getElementById('clear').addEventListener('click', () => post({ type: 'session.clear' }));
    document.getElementById('newSession').addEventListener('click', () => post({ type: 'session.new' }));
    attachEl.addEventListener('click', () => attachmentInputEl.click());
    attachmentInputEl.addEventListener('change', () => {
      const files = Array.from(attachmentInputEl.files || []);
      if (!files.length) {
        return;
      }
      ingestAttachments(files).catch((error) => {
        errorEl.hidden = false;
        errorEl.textContent = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        attachmentInputEl.value = '';
      });
    });
    tabButtons.forEach((buttonEl) => {
      buttonEl.addEventListener('click', () => {
        activeTab = buttonEl.dataset.tab || 'chat';
        renderTabs();
      });
    });

    document.getElementById('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      submitComposer();
    });

    inputEl.addEventListener('keydown', (event) => {
      if (handleSlashKeydown(event)) {
        return;
      }
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      if ((event.metaKey || event.ctrlKey) && isEnter) {
        event.preventDefault();
        submitComposer();
      }
    });

    inputEl.addEventListener('input', () => {
      requestSlashCompletions();
    });

    inputEl.addEventListener('click', () => {
      requestSlashCompletions();
    });

    inputEl.addEventListener('blur', () => {
      window.setTimeout(() => hideSlashCompletions(), 120);
    });

    function submitComposer() {
      if (activeRunId) {
        sendEl.disabled = true;
        sendEl.textContent = '■';
        sendEl.title = 'Stopping current agent run';
        sendEl.setAttribute('aria-label', 'Stopping current agent run');
        post({ type: 'agent.stop' });
        return;
      }
      sendCurrentMessage();
    }

    function sendCurrentMessage() {
      const text = inputEl.value.trim();
      if (!text && pendingAttachments.length === 0) {
        return;
      }
      inputEl.value = '';
      const attachments = pendingAttachments.slice();
      pendingAttachments = [];
      renderPendingAttachments();
      hideSlashCompletions();
      post({ type: 'chat.send', text, attachments });
    }

    async function ingestAttachments(files) {
      const next = [];
      for (const file of files) {
        next.push(await fileToAttachment(file));
      }

      const seen = new Set(pendingAttachments.map((item) => item.id));
      for (const item of next) {
        if (!seen.has(item.id)) {
          pendingAttachments.push(item);
          seen.add(item.id);
        }
      }
      renderPendingAttachments();
    }

    async function fileToAttachment(file) {
      const mimeType = String(file.type || guessMimeType(file.name) || 'application/octet-stream');
      const base = {
        id: createAttachmentId(file),
        name: file.name || 'attachment',
        mimeType,
        size: Number(file.size || 0),
      };

      if (mimeType.startsWith('image/')) {
        return {
          ...base,
          dataUrl: await readFileAsDataUrl(file),
        };
      }

      return {
        ...base,
        textPreview: await buildTextPreview(file, mimeType),
      };
    }

    function createAttachmentId(file) {
      return [file.name || 'attachment', file.size || 0, file.lastModified || 0].join(':');
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(file);
      });
    }

    async function buildTextPreview(file, mimeType) {
      if (!isTextLikeMimeType(mimeType) && !looksLikeTextFile(file.name)) {
        return '[binary file attachment] ' + file.name + ' (' + mimeType + ', ' + formatBytes(file.size || 0) + ')';
      }

      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsText(file);
      });
      const trimmed = text.length > 12000 ? text.slice(0, 12000) + '\\n...[truncated]' : text;
      return trimmed || '[empty text file] ' + file.name;
    }

    function isTextLikeMimeType(mimeType) {
      return mimeType.startsWith('text/')
        || /json|javascript|typescript|xml|yaml|yml|toml|markdown|md|csv|html|css|svg/i.test(mimeType);
    }

    function looksLikeTextFile(name) {
      return /\\.(txt|md|markdown|json|js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|hpp|css|html|xml|yml|yaml|toml|ini|cfg|sh|sql|csv|svg)$/i.test(String(name || ''));
    }

    function guessMimeType(name) {
      const lower = String(name || '').toLowerCase();
      if (/\\.(png)$/.test(lower)) return 'image/png';
      if (/\\.(jpe?g)$/.test(lower)) return 'image/jpeg';
      if (/\\.(gif)$/.test(lower)) return 'image/gif';
      if (/\\.(webp)$/.test(lower)) return 'image/webp';
      if (/\\.(svg)$/.test(lower)) return 'image/svg+xml';
      if (/\\.(txt|md|markdown)$/.test(lower)) return 'text/plain';
      if (/\\.(json)$/.test(lower)) return 'application/json';
      if (/\\.(js|mjs|cjs)$/.test(lower)) return 'text/javascript';
      if (/\\.(ts|tsx)$/.test(lower)) return 'text/typescript';
      if (/\\.(html)$/.test(lower)) return 'text/html';
      if (/\\.(css)$/.test(lower)) return 'text/css';
      if (/\\.(yml|yaml)$/.test(lower)) return 'text/yaml';
      return '';
    }

    function renderPendingAttachments() {
      attachmentsEl.innerHTML = '';
      if (!pendingAttachments.length) {
        return;
      }
      for (const attachment of pendingAttachments) {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip' + (attachment.mimeType.startsWith('image/') ? ' image' : '');

        if (attachment.mimeType.startsWith('image/') && attachment.dataUrl) {
          const thumb = document.createElement('img');
          thumb.className = 'attachment-thumb';
          thumb.src = attachment.dataUrl;
          thumb.alt = attachment.name;
          chip.appendChild(thumb);
        }

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';
        const name = document.createElement('div');
        name.className = 'attachment-name';
        name.textContent = attachment.name;
        name.title = attachment.name;
        const info = document.createElement('div');
        info.className = 'attachment-info';
        info.textContent = [attachment.mimeType, formatBytes(attachment.size)].filter(Boolean).join(' · ');
        meta.append(name, info);

        const remove = document.createElement('button');
        remove.className = 'attachment-remove';
        remove.type = 'button';
        remove.title = 'Remove attachment';
        remove.setAttribute('aria-label', 'Remove attachment');
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          pendingAttachments = pendingAttachments.filter((item) => item.id !== attachment.id);
          renderPendingAttachments();
        });

        chip.append(meta, remove);
        attachmentsEl.appendChild(chip);
      }
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
      }
      if (bytes >= 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(1).replace(/\\.0$/, '') + ' MB';
      }
      if (bytes >= 1024) {
        return (bytes / 1024).toFixed(1).replace(/\\.0$/, '') + ' KB';
      }
      return Math.round(bytes) + ' B';
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'session.updated') {
        session = message.session;
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        modelInfo = message.modelInfo || modelInfo;
        busy = Boolean(session.busy);
        activeRunId = session.activeRunId || undefined;
        queueLength = Number(session.queueLength || 0);
        if (!busy) {
          progress = 'Thinking...';
        }
        render();
      }
      if (message.type === 'agent.runStarted') {
        activeRunId = message.runId || activeRunId;
        renderComposer();
      }
      if (message.type === 'agent.runStopped') {
        if (!message.runId || message.runId === activeRunId) {
          activeRunId = undefined;
        }
        renderComposer();
      }
      if (message.type === 'agent.progress') {
        progress = message.message || 'Thinking...';
        errorEl.hidden = true;
        renderMessages();
      }
      if (message.type === 'slash.completions') {
        const requestNumber = Number(String(message.requestId || '').replace(/^slash-/, ''));
        if (requestNumber === slashCompletionRequestId) {
          slashCompletionItems = Array.isArray(message.items) ? message.items : [];
          slashCompletionActiveIndex = 0;
          renderSlashCompletions();
        }
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
      renderComposer();
      renderTabs();
      renderMessages();
      renderSessions();
      renderChanges();
      renderContext();
      renderUsage();
    }

    function renderComposer() {
      sendEl.disabled = false;
      inputEl.disabled = false;
      renderModelInfo();
      if (activeRunId) {
        sendEl.classList.add('stop');
        sendEl.textContent = '■';
        sendEl.title = 'Stop current agent run';
        sendEl.setAttribute('aria-label', 'Stop current agent run');
        return;
      }
      sendEl.classList.remove('stop');
      sendEl.textContent = '↑';
      sendEl.title = busy ? 'Queue message' : 'Send message';
      sendEl.setAttribute('aria-label', busy ? 'Queue message' : 'Send message');
    }

    function renderModelInfo() {
      const label = formatModelLabel(modelInfo);
      modelInfoEl.textContent = label;
      modelInfoEl.title = formatModelTitle(modelInfo);
    }

    function formatModelLabel(info) {
      if (!info) {
        return 'Model';
      }
      const provider = compactProviderName(info.provider);
      const model = info.model || 'unset';
      const thinking = info.thinking
        ? 'think:' + compactThinking(info.thinking)
        : 'effort:' + (info.reasoningEnabled === false ? 'off' : (info.effort || 'medium'));
      const context = 'ctx:' + formatContextUsage(info);
      const usage = formatUsagePill(session?.usage?.totals);
      return [provider, model, thinking, context, usage].filter(Boolean).join(' · ');
    }

    function formatModelTitle(info) {
      if (!info) {
        return 'Configure model';
      }
      const rows = [
        'Provider: ' + (info.provider || 'openai-compatible'),
        'API: ' + (info.api || 'chat-completions'),
        'Model: ' + (info.model || 'unset'),
        'Reasoning: ' + (info.reasoningEnabled === false ? 'disabled' : 'enabled'),
        'Effort: ' + (info.effort || 'medium'),
        info.thinking ? 'Thinking: ' + info.thinking : undefined,
        'Cache optimization: ' + formatCacheOptimization(info),
        'Context window: ' + formatContextUsage(info) + ' (' + formatChars(info.contextUsedChars) + ' / ' + formatChars(info.contextMaxChars) + ')',
        session?.usage?.totals ? 'Session usage: ' + formatUsageTooltip(session.usage.totals) : undefined,
      ].filter(Boolean);
      return rows.join('\\n');
    }

    function renderTabs() {
      tabButtons.forEach((buttonEl) => {
        buttonEl.classList.toggle('active', (buttonEl.dataset.tab || 'chat') === activeTab);
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.panel || 'chat') !== activeTab;
      });
    }

    function compactProviderName(provider) {
      if (provider === 'anthropic') return 'claude';
      if (provider === 'openai') return 'gpt';
      if (provider === 'openrouter') return 'openrouter';
      return provider || 'model';
    }

    function compactThinking(value) {
      if (value === 'adaptive') return 'adaptive';
      if (value === 'enabled') return 'on';
      if (value === 'disabled') return 'off';
      return value || 'auto';
    }

    function formatCacheOptimization(info) {
      if (info.cacheEnabled === false) {
        return 'disabled';
      }
      if (info.provider === 'anthropic') {
        return 'enabled (Claude block cache)';
      }
      if (info.provider === 'qwen') {
        return 'enabled (Qwen context cache)';
      }
      if (info.provider === 'openai') {
        return 'enabled (OpenAI prompt cache)';
      }
      if (info.provider === 'openrouter') {
        return 'enabled (OpenRouter/provider automatic)';
      }
      return 'enabled (provider automatic)';
    }

    function formatContextUsage(info) {
      const percent = Number(info?.contextUsagePercent);
      return Number.isFinite(percent) ? percent + '%' : '0%';
    }

    function formatChars(value) {
      const chars = Number(value || 0);
      if (!Number.isFinite(chars) || chars <= 0) {
        return '0';
      }
      if (chars >= 1000000) {
        return (chars / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M chars';
      }
      if (chars >= 1000) {
        return (chars / 1000).toFixed(1).replace(/\\.0$/, '') + 'k chars';
      }
      return String(Math.round(chars)) + ' chars';
    }

    function requestSlashCompletions() {
      const cursor = inputEl.selectionStart || 0;
      const text = inputEl.value || '';
      const beforeCursor = text.slice(0, cursor);
      if (!beforeCursor.startsWith('/') || beforeCursor.includes('\\n')) {
        hideSlashCompletions();
        return;
      }

      slashCompletionRequestId += 1;
      post({
        type: 'slash.completions',
        requestId: 'slash-' + slashCompletionRequestId,
        text,
        cursor
      });
    }

    function renderSlashCompletions() {
      slashMenuEl.innerHTML = '';
      if (!slashCompletionItems.length) {
        slashMenuEl.hidden = true;
        return;
      }

      slashCompletionItems.forEach((item, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'slash-item' + (index === slashCompletionActiveIndex ? ' active' : '');
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          applySlashCompletion(index);
        });

        const main = document.createElement('div');
        main.className = 'slash-main';
        const labelEl = document.createElement('div');
        labelEl.className = 'slash-label';
        labelEl.textContent = item.label || item.insertText || '';
        const descriptionEl = document.createElement('div');
        descriptionEl.className = 'slash-description';
        descriptionEl.textContent = item.description || item.detail || '';
        main.append(labelEl, descriptionEl);

        const kindEl = document.createElement('div');
        kindEl.className = 'slash-kind';
        kindEl.textContent = item.kind || 'item';
        option.append(main, kindEl);
        slashMenuEl.appendChild(option);
      });
      slashMenuEl.hidden = false;
    }

    function hideSlashCompletions() {
      slashCompletionItems = [];
      slashCompletionActiveIndex = 0;
      slashMenuEl.hidden = true;
      slashMenuEl.innerHTML = '';
    }

    function handleSlashKeydown(event) {
      if (slashMenuEl.hidden || !slashCompletionItems.length) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        slashCompletionActiveIndex = (slashCompletionActiveIndex + 1) % slashCompletionItems.length;
        renderSlashCompletions();
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        slashCompletionActiveIndex = (slashCompletionActiveIndex - 1 + slashCompletionItems.length) % slashCompletionItems.length;
        renderSlashCompletions();
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        applySlashCompletion(slashCompletionActiveIndex);
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        hideSlashCompletions();
        return true;
      }

      return false;
    }

    function applySlashCompletion(index) {
      const item = slashCompletionItems[index];
      if (!item) {
        return;
      }
      const text = inputEl.value || '';
      const cursor = inputEl.selectionStart || 0;
      const replaceStart = Number.isInteger(item.replaceStart) ? item.replaceStart : 0;
      const replaceEnd = Number.isInteger(item.replaceEnd) ? item.replaceEnd : cursor;
      const nextValue = text.slice(0, replaceStart) + item.insertText + text.slice(replaceEnd);
      const nextCursor = replaceStart + String(item.insertText || '').length;
      inputEl.value = nextValue;
      inputEl.focus();
      inputEl.setSelectionRange(nextCursor, nextCursor);
      hideSlashCompletions();
      requestSlashCompletions();
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
        if (message.kind === 'thinking') {
          item.appendChild(thinkingCard(message));
          messagesEl.appendChild(item);
          continue;
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.appendChild(label(messageLabel(message)));
        if (Array.isArray(message.attachments) && message.attachments.length) {
          bubble.appendChild(messageAttachmentList(message.attachments));
        }
        bubble.appendChild(markdown(message.content));
        if (message.status === 'running' && message.kind !== 'tool' && message.kind !== 'thinking') {
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

    function renderUsage() {
      const usage = session?.usage;
      if (!usage || !Array.isArray(usage.records) || !usage.records.length) {
        usageEl.innerHTML = '<div class="empty">Usage statistics will appear after model requests complete and return usage.</div>';
        return;
      }

      usageEl.innerHTML = '';
      usageEl.appendChild(usageTotalsCard(usage.totals));

      const list = document.createElement('div');
      list.className = 'usage-list';
      for (const record of [...usage.records].slice(-20).reverse()) {
        list.appendChild(usageRecordRow(record));
      }
      usageEl.appendChild(list);
    }

    function usageTotalsCard(totals) {
      const card = document.createElement('div');
      card.className = 'usage-card';
      const row = document.createElement('div');
      row.className = 'row';
      const title = document.createElement('div');
      title.className = 'label';
      title.textContent = 'Session total';
      row.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [
        totals.requestCount + ' req',
        totals.completedRequestCount + ' done',
        totals.interruptedRequestCount ? totals.interruptedRequestCount + ' interrupted' : '',
        totals.errorRequestCount ? totals.errorRequestCount + ' error' : ''
      ].filter(Boolean).join(' · ');

      const grid = document.createElement('div');
      grid.className = 'usage-grid';
      grid.append(
        usageMetric('Total tokens', formatCount(totals.totalTokens)),
        usageMetric('Input', formatCount(totals.inputTokens)),
        usageMetric('Output', formatCount(totals.outputTokens)),
        usageMetric('Reasoning', formatCount(totals.reasoningOutputTokens)),
        usageMetric('Cache', formatCount(totals.cachedInputTokens + totals.cacheReadInputTokens)),
        usageMetric('Est. cost', formatUsd(totals.costUsd))
      );

      card.append(row, meta, grid);
      return card;
    }

    function usageRecordRow(record) {
      const row = document.createElement('div');
      row.className = 'usage-row';
      const header = document.createElement('div');
      header.className = 'usage-row-header';
      const title = document.createElement('div');
      title.className = 'usage-row-title';
      title.textContent = [record.provider, record.model, record.api].filter(Boolean).join(' · ');
      const badge = document.createElement('div');
      badge.className = 'usage-badge';
      badge.textContent = record.status || 'complete';
      header.append(title, badge);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [
        record.step ? 'step ' + record.step : '',
        record.stream ? 'stream' : 'non-stream',
        record.source || '',
        record.completedAt ? relativeTime(record.completedAt) : ''
      ].filter(Boolean).join(' · ');

      const grid = document.createElement('div');
      grid.className = 'usage-grid';
      grid.append(
        usageMetric('Total', formatMaybeCount(record.totalTokens)),
        usageMetric('Input', formatMaybeCount(record.inputTokens)),
        usageMetric('Output', formatMaybeCount(record.outputTokens)),
        usageMetric('Reasoning', formatMaybeCount(record.reasoningOutputTokens)),
        usageMetric('Cache', formatMaybeCount((record.cachedInputTokens || 0) + (record.cacheReadInputTokens || 0) + (record.cacheCreationInputTokens || 0))),
        usageMetric('Cost', formatMaybeUsd(record.costUsd))
      );

      row.append(header, meta, grid);
      return row;
    }

    function usageMetric(labelText, valueText) {
      const wrap = document.createElement('div');
      const labelEl = document.createElement('div');
      labelEl.className = 'usage-metric-label';
      labelEl.textContent = labelText;
      const valueEl = document.createElement('div');
      valueEl.className = 'usage-metric-value';
      valueEl.textContent = valueText;
      wrap.append(labelEl, valueEl);
      return wrap;
    }

    function formatUsagePill(totals) {
      if (!totals || !Number.isFinite(Number(totals.totalTokens)) || Number(totals.totalTokens) <= 0) {
        return '';
      }
      return 'usage:' + formatCompactCount(Number(totals.totalTokens));
    }

    function formatUsageTooltip(totals) {
      return [
        'requests ' + formatCount(totals.requestCount),
        'total ' + formatCount(totals.totalTokens),
        'input ' + formatCount(totals.inputTokens),
        'output ' + formatCount(totals.outputTokens),
        'reasoning ' + formatCount(totals.reasoningOutputTokens),
        'cache ' + formatCount(totals.cachedInputTokens + totals.cacheReadInputTokens),
        'cost ' + formatUsd(totals.costUsd),
      ].join(' · ');
    }

    function formatCount(value) {
      const number = Number(value || 0);
      if (!Number.isFinite(number)) {
        return '0';
      }
      return Math.round(number).toLocaleString();
    }

    function formatCompactCount(value) {
      const number = Number(value || 0);
      if (!Number.isFinite(number) || number <= 0) {
        return '0';
      }
      if (number >= 1000000) {
        return (number / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
      }
      if (number >= 1000) {
        return (number / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
      }
      return String(Math.round(number));
    }

    function formatMaybeCount(value) {
      return Number.isFinite(Number(value)) && Number(value) > 0 ? formatCount(value) : 'unknown';
    }

    function formatUsd(value) {
      const number = Number(value || 0);
      if (!Number.isFinite(number)) {
        return '$0.0000';
      }
      return '$' + number.toFixed(number >= 1 ? 2 : 4);
    }

    function formatMaybeUsd(value) {
      return Number.isFinite(Number(value)) ? formatUsd(value) : 'unknown';
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
        const status = message.status === 'error'
          ? 'error'
          : message.status === 'complete'
            ? 'done'
            : message.status === 'interrupted'
              ? 'interrupted'
              : message.status === 'queued'
                ? 'queued'
                : 'running';
        return 'tool · ' + (message.toolName || 'tool') + ' · ' + status;
      }
      if (message.kind === 'thinking') {
        const status = message.status === 'complete'
          ? 'done'
          : message.status === 'interrupted'
            ? 'interrupted'
            : message.status === 'error'
              ? 'error'
              : 'streaming';
        return 'thinking · ' + status;
      }
      if (message.status === 'running') {
        return message.role + ' · streaming';
      }
      if (message.status === 'queued') {
        return message.role + ' · queued';
      }
      if (message.status === 'interrupted') {
        return message.role + ' · interrupted';
      }
      return message.role;
    }

    function messageAttachmentList(attachments) {
      const list = document.createElement('div');
      list.className = 'attachment-list';
      for (const attachment of attachments) {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip' + (String(attachment.mimeType || '').startsWith('image/') ? ' image' : '');
        if (String(attachment.mimeType || '').startsWith('image/') && attachment.dataUrl) {
          const thumb = document.createElement('img');
          thumb.className = 'attachment-thumb';
          thumb.src = attachment.dataUrl;
          thumb.alt = attachment.name || 'image';
          chip.appendChild(thumb);
        }
        const meta = document.createElement('div');
        meta.className = 'attachment-meta';
        const name = document.createElement('div');
        name.className = 'attachment-name';
        name.textContent = attachment.name || 'attachment';
        const info = document.createElement('div');
        info.className = 'attachment-info';
        info.textContent = [attachment.mimeType || '', formatBytes(attachment.size || 0)].filter(Boolean).join(' · ');
        meta.append(name, info);
        chip.appendChild(meta);
        list.appendChild(chip);
      }
      return list;
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
      status.textContent = message.status === 'error'
        ? 'error'
        : message.status === 'complete'
          ? 'complete'
          : message.status === 'interrupted'
            ? 'interrupted'
            : message.status === 'queued'
              ? 'queued'
              : 'running';
      body.appendChild(status);
      if (isPlainObject(message.metadata?.input)) {
        body.appendChild(toolSection('Input', jsonBlock(message.metadata.input)));
      }
      body.appendChild(toolSection('Output', toolOutput(message.content)));

      card.append(summary, body);
      return card;
    }

    function toolStateKey(message) {
      return message.toolUseId || message.id || message.toolName || 'tool';
    }

    function thinkingCard(message) {
      const card = document.createElement('details');
      card.className = ['thinking-card', message.status || ''].filter(Boolean).join(' ');
      const stateKey = thinkingStateKey(message);
      card.open = openThinkingMessages.has(stateKey);
      card.addEventListener('toggle', () => {
        if (card.open) {
          openThinkingMessages.add(stateKey);
        } else {
          openThinkingMessages.delete(stateKey);
        }
      });

      const summary = document.createElement('summary');
      summary.className = 'thinking-summary';
      const name = document.createElement('span');
      name.className = 'thinking-name';
      name.textContent = 'thinking';
      const params = document.createElement('span');
      params.className = 'thinking-params';
      params.textContent = formatThinkingSummary(message);
      summary.append(name, params);

      const body = document.createElement('div');
      body.className = 'thinking-body';
      const status = document.createElement('div');
      status.className = 'thinking-status';
      status.textContent = message.status === 'complete'
        ? 'complete'
        : message.status === 'interrupted'
          ? 'interrupted'
          : message.status === 'error'
            ? 'error'
            : 'streaming';
      body.appendChild(status);
      body.appendChild(thinkingSection('Reasoning', thinkingOutput(message.content)));

      card.append(summary, body);
      return card;
    }

    function thinkingStateKey(message) {
      return message.id || 'thinking';
    }

    function formatThinkingSummary(message) {
      const content = String(message.content || '').replace(/\\s+/g, ' ').trim();
      if (message.status === 'running') {
        return content ? content.slice(0, 180) : 'streaming';
      }
      if (!content) {
        return 'empty';
      }
      return content.length > 180 ? content.slice(0, 179) + '…' : content;
    }

    function thinkingSection(title, contentNode) {
      const section = document.createElement('div');
      section.className = 'thinking-section';
      const heading = document.createElement('div');
      heading.className = 'thinking-section-title';
      heading.textContent = title;
      section.append(heading, contentNode);
      return section;
    }

    function thinkingOutput(content) {
      const pre = document.createElement('pre');
      pre.className = 'thinking-text';
      pre.textContent = String(content || '');
      return pre;
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

    function toolSection(title, contentNode) {
      const section = document.createElement('div');
      section.className = 'tool-section';
      const heading = document.createElement('div');
      heading.className = 'tool-section-title';
      heading.textContent = title;
      section.append(heading, contentNode);
      return section;
    }

    function toolOutput(content) {
      const parsed = parseJsonLike(content);
      if (parsed.ok) {
        return jsonBlock(parsed.value);
      }
      return markdown(content);
    }

    function jsonBlock(value) {
      const pre = document.createElement('pre');
      pre.className = 'tool-json';
      pre.textContent = JSON.stringify(value, null, 2);
      return pre;
    }

    function parseJsonLike(value) {
      const text = String(value || '').trim();
      if (!text || !/^[{[]/.test(text)) {
        return { ok: false };
      }
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false };
      }
    }

    function isPlainObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value);
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
