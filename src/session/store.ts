import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Event, Message } from '../core/types.js';
export interface Meta { id: string; workspace: string; provider: string }
export interface RecordLine { version: 1; seq: number; time: string; event: Event }
export function sessionId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Session ID must contain 1–80 letters, numbers, _ or -');
  return id;
}
function readJournal(path: string): { records: RecordLine[]; validBytes: number } {
  if (!existsSync(path)) return { records: [], validBytes: 0 };
  if (statSync(path).size > 32_000_000) throw new Error('Session exceeds teaching journal limit (32 MB)');
  const raw = readFileSync(path, 'utf8');
  const last = raw.lastIndexOf('\n');
  const complete = raw.slice(0, last + 1);
  const records = complete ? complete.trimEnd().split('\n').map((line, i): RecordLine => {
    let r: RecordLine;
    try { r = JSON.parse(line) as RecordLine; } catch { throw new Error(`Corrupt journal line ${i + 1}`); }
    if (r.version !== 1 || r.seq !== i || !r.event || typeof r.event.type !== 'string') throw new Error(`Invalid journal record ${i + 1}`);
    return r;
  }) : [];
  return { records, validBytes: Buffer.byteLength(complete) };
}
/** 同一 session 一个写者；每个事件同步追加并 fsync，先落盘工具意图再执行。 */
export class SessionStore {
  readonly records: RecordLine[];
  private fd: number;
  private closed = false;
  private constructor(readonly path: string, private lock: string, records: RecordLine[]) {
    this.records = records; this.fd = openSync(path, 'a', 0o600);
  }
  static open(home: string, meta: Meta): SessionStore {
    sessionId(meta.id);
    const folder = resolve(home, 'sessions'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, meta.id + '.jsonl'), lock = path + '.lock';
    try { mkdirSync(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Session is locked: ${lock}. Check the recorded PID before removing a stale lock.`);
      throw error;
    }
    let store: SessionStore | undefined;
    try {
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      const { records, validBytes } = readJournal(path);
      if (records.length) {
        const first = records[0]!.event;
        if (first.type !== 'session.created' || first.workspace !== meta.workspace || first.provider !== meta.provider || first.id !== meta.id) throw new Error('Session belongs to a different workspace/provider/model; use a new session');
      }
      // 仅修剪没有换行的尾部；完整行损坏必须报错，不能静默跳过。
      if (existsSync(path) && statSync(path).size !== validBytes) truncateSync(path, validBytes);
      store = new SessionStore(path, lock, records);
      if (!records.length) store.append({ type: 'session.created', ...meta });
      return store;
    } catch (error) { store?.close(); rmSync(lock, { recursive: true, force: true }); throw error; }
  }
  append(event: Event): void {
    if (this.closed) throw new Error('Session is closed');
    const record: RecordLine = { version: 1, seq: this.records.length, time: new Date().toISOString(), event };
    appendFileSync(this.fd, JSON.stringify(record) + '\n'); fsyncSync(this.fd); this.records.push(record);
  }
  messages(): Message[] { return this.records.filter(r => r.event.type === 'message').map(r => r.event.message as Message); }
  close(): void {
    if (this.closed) return;
    this.closed = true; try { closeSync(this.fd); } finally { rmSync(this.lock, { recursive: true, force: true }); }
  }
}
export function readSession(home: string, id: string): RecordLine[] {
  const path = join(resolve(home), 'sessions', sessionId(id) + '.jsonl');
  if (!existsSync(path)) throw new Error(`Unknown session: ${id}`);
  return readJournal(path).records;
}
export function listSessions(home: string): unknown[] {
  const folder = resolve(home, 'sessions');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(f => f.endsWith('.jsonl')).sort().map(file => {
    const records = readJournal(join(folder, file)).records;
    return { ...records[0]?.event, events: records.length, updated: records.at(-1)?.time };
  });
}
