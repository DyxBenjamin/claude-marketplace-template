/**
 * @file CLI that checks skill folders against the marketplace skill rules and prints a FAIL line per violation
 * @tags skill-creator, validation, cli
 * @related plugins/base-plugin/scripts/check-skills.ts, plugins/base-plugin/scripts/verbs.txt
 */
// Usage: node check_skill.ts <skill-dir>... Checks each skill folder against the marketplace skill rules
// (check-skills.ts and verbs.txt, stamped from review-marketplace). Prints "FAIL <check>: <path>: <detail>" per
// violation; exits 1 on any.
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';
import { checkSkillDir, loadVerbs } from './check-skills.ts';

const SkillDir = z.string().refine((d) => fs.existsSync(path.join(d, 'SKILL.md')), {
  error: (iss) => `${String(iss.input)} holds no SKILL.md`,
});
const Args = z.array(SkillDir).min(1, 'Usage: node check_skill.ts <skill-dir>...');

const parsed = Args.safeParse(process.argv.slice(2));
if (!parsed.success) {
  console.log(parsed.error.issues.map((i) => i.message).join('\n'));
  process.exit(1);
}

const verbs = loadVerbs(path.join(import.meta.dirname, 'verbs.txt'));
let fails = 0;
for (const dir of parsed.data) {
  checkSkillDir(path.resolve(dir), verbs, (check, file, detail) => {
    console.log(`FAIL ${check}: ${path.relative(process.cwd(), file)}: ${detail}`);
    fails++;
  });
}
process.exit(fails ? 1 : 0);
