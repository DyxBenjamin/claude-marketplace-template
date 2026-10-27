/**
 * @file Stamps the delegation and builder templates and the skill checker into every skill unit; --check reports drift
 * @tags delegation, ci, skills
 * @related templates/delegate.md, templates/builder.md, .claude/skills/review-marketplace/check-skills.ts
 */
// Usage: node scripts/stamp-delegation.ts [--check]. Copies templates/delegate.md into every skill folder
// (plugins/*/skills/*/ and .claude/skills/*/) and templates/builder.md into the agents/ folder of every unit that
// holds a skill (plugins/<plugin>/agents/ and .claude/agents/). <agent> in delegate.md becomes the builder's
// subagent type: <plugin>:builder in a plugin, builder in the project. A plugin with scripts/check_skill.ts also
// gets check-skills.ts and verbs.txt from review-marketplace. --check exits 1 when a copy is missing or differs,
// without writing.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const root = path.resolve(import.meta.dirname, '..');
const Args = z.union([z.tuple([]), z.tuple([z.literal('--check')])]);
const check = Args.parse(process.argv.slice(2)).length === 1;
const Template = z.string().min(1);
const delegate = Template.parse(fs.readFileSync(path.join(root, 'templates/delegate.md'), 'utf8'));
const builder = Template.parse(fs.readFileSync(path.join(root, 'templates/builder.md'), 'utf8'));

function skillDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => path.join(dir, e.name));
}

const units: { skills: string; agents: string; agent: string }[] = [
  { skills: path.join(root, '.claude/skills'), agents: path.join(root, '.claude/agents'), agent: 'builder' },
];
for (const plugin of fs.readdirSync(path.join(root, 'plugins')).sort()) {
  const dir = path.join(root, 'plugins', plugin);
  units.push({ skills: path.join(dir, 'skills'), agents: path.join(dir, 'agents'), agent: `${plugin}:builder` });
}

const files: [string, string][] = [];
for (const unit of units) {
  const dirs = skillDirs(unit.skills);
  if (!dirs.length) continue;
  for (const dir of dirs) files.push([path.join(dir, 'delegate.md'), delegate.replaceAll('<agent>', unit.agent)]);
  files.push([path.join(unit.agents, 'builder.md'), builder]);
}

// A plugin that validates the skills it writes (scripts/check_skill.ts) gets the repository's skill rules, with
// zod from its vendored copy.
const rules = path.join(root, '.claude/skills/review-marketplace');
const checker = Template.parse(fs.readFileSync(path.join(rules, 'check-skills.ts'), 'utf8'));
const verbs = Template.parse(fs.readFileSync(path.join(rules, 'verbs.txt'), 'utf8'));
for (const plugin of fs.readdirSync(path.join(root, 'plugins')).sort()) {
  const scripts = path.join(root, 'plugins', plugin, 'scripts');
  if (!fs.existsSync(path.join(scripts, 'check_skill.ts'))) continue;
  files.push([path.join(scripts, 'check-skills.ts'), checker.replace("from 'zod'", "from '../vendor/zod.generated.js'")]);
  files.push([path.join(scripts, 'verbs.txt'), verbs]);
}

let stale = 0;
for (const [target, content] of files) {
  const rel = path.relative(root, target);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === content) continue;
  if (check) {
    console.log(`stale ${rel}; run npm run stamp`);
    stale++;
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`wrote ${rel}`);
}
process.exit(stale ? 1 : 0);
