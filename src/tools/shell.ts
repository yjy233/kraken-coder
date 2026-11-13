import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** 本机执行，不是沙箱。POSIX 下用进程组取消子孙进程；禁止自动继承 API 密钥。 */
export async function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (process.platform === 'win32') throw new Error('Teaching shell currently supports macOS/Linux only');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', truncated = false, timedOut = false;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const append = (text: string): void => {
      const room = Math.max(0, 16_000 - output.length);
      output += text.slice(0, room); if (text.length > room) truncated = true;
    };
    child.stdout.on('data', b => append(decoders[0]!.write(b)));
    child.stderr.on('data', b => append(decoders[1]!.write(b)));
    const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
    const abort = (): void => kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (exitCode, exitSignal) => {
      cleanup(); decoders.forEach(d => append(d.end()));
      if (signal.aborted) { reject(signal.reason); return; }
      resolve({ exitCode, signal: exitSignal, timedOut, output, truncated });
    });
    if (signal.aborted) kill();
  });
}
