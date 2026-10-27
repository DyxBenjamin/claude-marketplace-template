/**
 * @file CLI that writes delegate.md and the builder agent contract into a generated skill and its agents folder
 * @tags skill-creator, delegation, cli
 * @related plugins/base-plugin/skills/write-skill/delegate.md, plugins/base-plugin/agents/builder.md
 */
// Usage: node embed_delegation.ts <skill-dir> <agent> <agents-dir>. Embeds delegation in a generated skill: writes
// <skill-dir>/delegate.md from this plugin's skills/write-skill/delegate.md with base-plugin:builder replaced by
// <agent>, and <agents-dir>/builder.md from this plugin's agents/builder.md. A file already identical is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';

const plugin = path.resolve(import.meta.dirname, '..');
const Args = z.tuple([
  z.string().refine((d) => fs.existsSync(path.join(d, 'SKILL.md')), { error: 'skill-dir holds no SKILL.md' }),
  z.string().regex(/^[\w-]+(:[\w-]+)*$/, 'agent is a subagent type such as my-plugin:builder or builder'),
  z.string().min(1),
]);
const Template = z.string().min(1);

const parsed = Args.safeParse(process.argv.slice(2));
if (!parsed.success) {
  console.log('Usage: node embed_delegation.ts <skill-dir> <agent> <agents-dir>');
  console.log(parsed.error.issues.map((i) => i.message).join('\n'));
  process.exit(1);
}
const [skillDir, agent, agentsDir] = parsed.data;

const read = (rel: string): string => Template.parse(fs.readFileSync(path.join(plugin, rel), 'utf8'));
const files: [string, string][] = [
  [path.join(skillDir, 'delegate.md'), read('skills/write-skill/delegate.md').replaceAll('base-plugin:builder', agent)],
  [path.join(agentsDir, 'builder.md'), read('agents/builder.md')],
];

for (const [target, content] of files) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === content) {
    console.log(`skipped ${target}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`wrote ${target}`);
}
