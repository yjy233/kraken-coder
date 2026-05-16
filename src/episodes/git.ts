import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getGitBranch(workspaceRoot?: string): Promise<string> {
  if (!workspaceRoot) {
    return 'unknown';
  }

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: workspaceRoot,
      timeout: 2000,
    });
    const branch = stdout.trim();
    return branch || 'detached';
  } catch {
    return 'unknown';
  }
}
