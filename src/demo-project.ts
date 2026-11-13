import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const calculatorSource = 'export function add(a, b) {\n  return a - b;\n}\n';
export const calculatorTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calculator.js';
test('adds positive numbers', () => assert.equal(add(2, 3), 5));
test('adds negative numbers', () => assert.equal(add(-2, -3), -5));
test('zero is identity', () => assert.equal(add(0, 7), 7));
`;
export async function createDemoProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kraken-demo-'));
  await mkdir(join(root, '.agents/skills/review'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test calculator.test.js"}}\n'),
    writeFile(join(root, 'calculator.js'), calculatorSource),
    writeFile(join(root, 'calculator.test.js'), calculatorTest),
    writeFile(join(root, 'AGENTS.md'), '# Calculator\n只修改 calculator.js；保留现有测试，用 node --test calculator.test.js 验证。\n'),
    writeFile(join(root, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: 检查修改与测试证据\n---\n先阅读代码和测试，再复现、修复、验证。最终说明实际测试结果。\n'),
  ]);
  return root;
}
