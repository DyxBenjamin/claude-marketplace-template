/**
 * @file Validates skill folders and agent contracts against the skill rules; exports checkSkillDir, checkAgent, loadVerbs
 * @tags validation, skills, agents
 * @related .claude/skills/review-marketplace/check-rules.ts, .claude/skills/review-marketplace/verbs.txt, .claude/skills/review-marketplace/rules.md
 */
// Skill and agent checks for check-rules.ts: one objective, a short atomic plan, a spine within budget, siblings
// one level deep and referenced, embedded delegation, and agent contracts with a check, a loop, a ceiling and a
// compressed result.
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';

export type Fail = (check: string, file: string, detail: string) => void;

const MAX_LINES = 100;
const MAX_WIDTH = 120;
const MAX_STEPS = 10;
const MAX_DESCRIPTION = 250;
const MAX_LISTING = 600;
const CODE = /\.(sh|ts|tsx|mts|js|json|html|png|svg|wav|mp3|txt)$/;
const CEILING = /max(imum)? iterations|at most \d+ (iterations|attempts|rounds)|stops? (at|after) \d+/i;
const Verbs = z.array(z.string().regex(/^[a-z]+$/)).min(1);

export function loadVerbs(file: string): Set<string> {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  return new Set(Verbs.parse(lines.filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0])));
}

function frontField(front: string, key: string): string {
  const quoted = front.match(new RegExp(`^${key}:\\s*'((?:[^']|'')*)'`, 'ms'));
  if (quoted) return quoted[1].replace(/''/g, "'").replace(/\s*\n\s*/g, ' ');
  return front.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
}

function splitFront(text: string): { front: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: '', body: text };
}

function checkSize(file: string, text: string, fail: Fail): void {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length > MAX_LINES) fail('skills', file, `${lines.length} lines, at most ${MAX_LINES}; move a path into a sibling`);
  const wide = lines.findIndex((l) => l.length > MAX_WIDTH);
  if (wide >= 0) fail('skills', file, `line ${wide + 1} is wider than ${MAX_WIDTH} characters`);
}

function section(body: string, heading: string): string | null {
  const m = body.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

export function checkSkillDir(dir: string, verbs: Set<string>, fail: Fail): void {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const { front, body } = splitFront(text);
  checkSize(file, text, fail);

  const name = frontField(front, 'name');
  const parts = name.split('-');
  if (name !== path.basename(dir)) fail('skills', file, `name "${name}" differs from its folder`);
  if (!verbs.has(parts[0])) fail('skills', file, `"${parts[0]}" is not a verb in verbs.txt`);
  if (parts.length < 2 || parts.length > 3 || name.length > 24) fail('skills', file, `name "${name}" is not <verb>-<object>`);
  const description = frontField(front, 'description');
  const listing = description.length + frontField(front, 'when_to_use').length;
  if (description.length > MAX_DESCRIPTION) fail('skills', file, `description is ${description.length} characters, at most ${MAX_DESCRIPTION}`);
  if (listing > MAX_LISTING) fail('skills', file, `description + when_to_use is ${listing} characters, at most ${MAX_LISTING}`);
  if (/use when/i.test(description)) fail('skills', file, 'trigger phrases go in when_to_use');

  if (!/^Objective: \S/m.test(body)) fail('skills', file, 'no "Objective:" line');
  const steps = section(body, 'Steps');
  const top = steps?.match(/^\d+\. /gm)?.length ?? 0;
  if (!top) fail('skills', file, 'no numbered "## Steps"');
  if (top > MAX_STEPS) fail('skills', file, `${top} steps, at most ${MAX_STEPS}; split the skill`);
  const output = section(body, 'Output');
  if (!output || !/Check:/.test(output)) fail('skills', file, 'no "## Output" with a "Check:"');
  if (!body.includes('delegate.md')) fail('skills', file, 'does not run its Steps through delegate.md');

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const sub = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const doc of fs.readdirSync(sub, { recursive: true, encoding: 'utf8' })) {
        if (doc.endsWith('.md')) fail('skills', path.join(sub, doc), 'doc nested below the skill folder; keep siblings one level deep');
      }
    } else if (entry.name !== 'SKILL.md' && !CODE.test(entry.name) && !text.includes(entry.name)) {
      fail('skills', sub, 'sibling not referenced in SKILL.md');
    }
  }
}

export function checkAgent(file: string, fail: Fail): void {
  const text = fs.readFileSync(file, 'utf8');
  const { front, body } = splitFront(text);
  checkSize(file, text, fail);
  if (!/^tools:/m.test(front)) fail('agents', file, 'no tools line');
  if (/^You are\b|\bI am\b/m.test(body)) fail('agents', file, 'persona; the contract states what Claude does');
  if (!/^Objective: \S/m.test(body)) fail('agents', file, 'no "Objective:" line');
  if (!/reason→act→verify/.test(body)) fail('agents', file, 'no reason→act→verify loop');
  if (!CEILING.test(body)) fail('agents', file, 'no iteration ceiling');
  if (!section(body, 'Output')) fail('agents', file, 'no "## Output" result format');
}
