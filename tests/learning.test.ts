import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { algorithms } from '../src/learning/index.js';
import { stages } from '../src/lab.js';
for (const mode of ['reference', 'learner'] as const) {
  for (const [stage, cases] of stages.entries()) for (const entry of cases) {
    test(`${mode}/L${stage}: ${entry.name}`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'kraken-test-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await entry.run(algorithms(mode), root);
    });
  }
}
