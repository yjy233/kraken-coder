// @ts-check

/** @typedef {import('../server/protocol.js').ServerFrame} ServerFrame */

export class AgentClientError extends Error {
  /** @param {number} status @param {string} message @param {string} [code] */
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'AgentClientError';
    this.status = status;
    this.code = code;
  }
}

/** Shared by the browser and CLI; no agent logic or provider credentials live here. */
export class AgentClient {
  #token;
  /** @param {string} [baseUrl] @param {string} [token] */
  constructor(baseUrl = '', token = '') {
    const url = new URL(baseUrl || globalThis.location.origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Agent server must be a local http://127.0.0.1 or http://localhost URL');
    }
    this.#token = token || new URLSearchParams(url.hash.slice(1)).get('token') || '';
    this.baseUrl = url.origin;
  }

  /** @param {string} path @param {unknown} [body] @returns {Promise<any>} */
  async request(path, body) {
    const response = await fetch(this.baseUrl + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) await this.failure(response);
    return response.json();
  }

  /** @param {Response} response @returns {Promise<never>} */
  async failure(response) {
    const data = await response.json().catch(() => ({}));
    throw new AgentClientError(response.status, data.error?.message || `Agent server returned HTTP ${response.status}`, data.error?.code);
  }

  /** @returns {Promise<import('../server/protocol.js').ServerInfo>} */
  info() { return this.request('/info'); }
  /** @returns {Promise<import('../server/protocol.js').SessionSummary[]>} */
  async sessions() { return (await this.request('/sessions')).sessions; }
  /** @returns {Promise<import('../server/protocol.js').SessionSummary>} */
  async createSession() { return (await this.request('/sessions', {})).session; }
  /** @param {string} id @returns {Promise<import('../server/protocol.js').SessionSnapshot>} */
  session(id) { return this.request(`/sessions/${encodeURIComponent(id)}`); }
  /** @param {string} id @param {string} message @returns {Promise<import('../server/protocol.js').TurnState>} */
  async startTurn(id, message) { return (await this.request(`/sessions/${encodeURIComponent(id)}/turns`, { message })).turn; }
  /** @param {string} id @param {string} turnId @returns {Promise<{ok: true}>} */
  cancelTurn(id, turnId) { return this.request(`/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/cancel`, {}); }
  /** @param {string} id @param {string} approvalId @param {boolean} approved @returns {Promise<{ok: true}>} */
  approve(id, approvalId, approved) { return this.request(`/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { approved }); }

  /**
   * A fresh authoritative snapshot starts each connection. Reconnect explicitly;
   * never retry startTurn automatically after a transport failure.
   * @param {string} id @param {(frame: ServerFrame) => void} onFrame @param {AbortSignal} signal
   */
  async watchSession(id, onFrame, signal) {
    const response = await fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(id)}/events`, {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'text/event-stream' },
      credentials: 'omit', signal,
    });
    if (!response.ok) await this.failure(response);
    if (!response.body) throw new Error('Agent server returned an empty event stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { if (!signal.aborted) throw new Error('Agent server event stream disconnected'); return; }
        buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) onFrame(JSON.parse(data));
        }
        if (buffer.length > 40_000_000) throw new Error('Agent server event frame exceeds limit');
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
