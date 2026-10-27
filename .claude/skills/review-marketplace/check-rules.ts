/**
 * @file Checks plugins, repository code and the catalog against the mechanical rules.md rules; prints FAIL lines
 * @tags validation, marketplace, ci
 * @related .claude/skills/review-marketplace/rules.md, .claude/skills/review-marketplace/allowed-ext.txt, .claude/skills/review-marketplace/review.ts
 */
// Usage: check-rules.ts [repo root] [plugin dir...]. Checks the mechanical rules of rules.md on each plugin
// (all of plugins/ when none is named) and on the catalog; with no plugin named it also checks the technology
// rules on scripts/ and .claude/skills/, and the skill and agent rules on .claude/skills/ and .claude/agents/.
// Prints "FAIL <check>: <file>: <detail>" per violation; exits 1 on any.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { checkAgent, checkSkillDir, loadVerbs } from './check-skills.ts';

const Args = z.object({ root: z.string().default('.'), named: z.array(z.string()) });
const PluginManifest = z.looseObject({ license: z.unknown().optional() });
const Catalog = z.looseObject({
  plugins: z.array(z.looseObject({ name: z.unknown(), source: z.unknown() })).optional(),
});
const HookGroups = z.array(z.looseObject({ matcher: z.unknown().optional() }));
const HooksFile = z.looseObject({
  hooks: z.looseObject({
    PreToolUse: HookGroups.optional(),
    PostToolUse: HookGroups.optional(),
    PermissionRequest: HookGroups.optional(),
  }).optional(),
});

const here = import.meta.dirname;
const args = Args.parse({ root: process.argv[2], named: process.argv.slice(3) });
const root = path.resolve(args.root);
let fails = 0;
const fail = (check: string, file: string, detail: string): void => {
  console.log(`FAIL ${check}: ${path.relative(root, file)}: ${detail}`);
  fails++;
};

const allowed = fs
  .readFileSync(path.join(here, 'allowed-ext.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const verbs = loadVerbs(path.join(here, 'verbs.txt'));
const SKIP_DIRS = new Set(['node_modules', '.git', 'results']);
const CODE = /\.(sh|js|mjs|cjs|ts|tsx|mts)$/;
const CONFIG = /\.(json|ya?ml)$/;
const PATH_CONFIGS = new Set(['hooks.json', '.mcp.json', '.lsp.json', 'monitors.json']);
const OWNED = new Set(['skills', 'agents', 'commands', 'rules']);
const SPANISH = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
const ABSOLUTE = /(^|[\s"'=(:])(\/Users\/|\/home\/|~\/|\$HOME\/)/;
const SECOND_PERSON = /\b(you|your|yours|yourself|you're|please)\b/i;
const SHOUTING = /\b(MUST|ALWAYS|NEVER|IMPORTANT|CRITICAL)\b/;
const READS_INPUT = /JSON\.parse|process\.argv|process\.stdin|process\.env|readFileSync/;
const IMPORTS_ZOD = /^\s*import\s[^;]*?from\s*['"](?:zod|(?:[^'"]*\/)?vendor\/zod\.generated\.js)['"]/m;
const MAX_SH_LINES = 5;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || full.endsWith(path.join('.claude-plugin', 'types'))) continue;
      walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Splits a Markdown file into its frontmatter and its body with fenced code blocks removed.
function splitMarkdown(text: string): { front: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const front = m ? m[1] : '';
  const body = (m ? text.slice(m[0].length) : text).replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  return { front, body: body.replace(/`[^`\n]*`/g, '') };
}

function isInstruction(rel: string): boolean {
  return /^(skills|agents|output-styles)\//.test(rel) && rel.endsWith('.md') && !rel.endsWith('README.md');
}

// Technology rules for one file of plugins/, scripts/ or .claude/skills/. Returns false when the file is skipped.
function checkTech(file: string): boolean {
  const base = path.basename(file);
  const ext = path.extname(file);
  const generated = base.includes('.generated.');
  if (/\.(js|mjs|cjs)$/.test(file) && !file.endsWith(`vendor${path.sep}zod.generated.js`)) {
    fail('tech', file, 'JavaScript is generated only (vendor/zod.generated.js); write TypeScript');
  } else if (!allowed.includes(base) && !(ext && allowed.includes(ext))) {
    fail('tech', file, `file type not in allowed-ext.txt`);
    return false;
  }
  if (generated) return false;
  if (ext === '.sh') {
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    if (code > MAX_SH_LINES) fail('tech', file, `.sh holds ${code} code lines, at most ${MAX_SH_LINES}; run a .ts file`);
  }
  if (ext === '.ts' && !/\.(test|d)\.ts$/.test(base)) {
    const text = fs.readFileSync(file, 'utf8');
    if (READS_INPUT.test(text) && !IMPORTS_ZOD.test(text)) fail('zod', file, 'reads input without importing zod');
  }
  return true;
}

function checkPlugin(dir: string): void {
  const name = path.basename(dir);
  const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) return;
  const pj = PluginManifest.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  if (fs.existsSync(path.join(dir, 'commands'))) fail('format', path.join(dir, 'commands'), 'entry points are skills');
  if (fs.existsSync(path.join(dir, 'LICENSE')) && !pj.license) fail('license', manifest, 'LICENSE with no license field');

  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    const base = path.basename(file);
    const ext = path.extname(file);
    if (!checkTech(file)) continue;
    if (!/\.(md|json|ya?ml|txt|sh|js|mjs|cjs|ts|tsx|mts)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const isMd = ext === '.md';
    const { front, body } = isMd ? splitMarkdown(text) : { front: '', body: text };

    if (SPANISH.test(body)) fail('language', file, 'non-English text outside frontmatter');
    if ((CODE.test(file) || CONFIG.test(file)) && ABSOLUTE.test(text)) fail('path', file, 'absolute path');
    if (PATH_CONFIGS.has(base) && text.includes('../')) fail('path', file, '"../" path; use ${CLAUDE_PLUGIN_ROOT}');
    for (const [, folder] of text.matchAll(/\.claude\/([A-Za-z0-9_-]+)\//g)) {
      if (folder !== name && !OWNED.has(folder)) fail('data', file, `writes .claude/${folder}/, not .claude/${name}/`);
    }

    if (isMd && isInstruction(rel)) {
      const lines = body.split('\n');
      const you = lines.find((l) => SECOND_PERSON.test(l));
      if (you) fail('tone', file, `second person or "please": ${you.trim().slice(0, 80)}`);
      const loud = lines.find((l) => SHOUTING.test(l));
      if (loud) fail('tone', file, `all-caps urgency: ${loud.trim().slice(0, 80)}`);
    }
    if (isMd && /^agents\//.test(rel)) checkAgent(file, fail);
    const grant = front.match(/^allowed-tools:\s*(.*)$/m);
    if (grant && /(^|[\s,'"[])(Bash|\*)(?=$|[\s,'"\]])/.test(grant[1])) fail('tools', file, 'unscoped allowed-tools grant');
    if (base === 'hooks.json') checkHooks(file, text);
  }
  checkSkills(path.join(dir, 'skills'));
}

function checkSkills(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) checkSkillDir(path.join(dir, entry.name), verbs, fail);
  }
}

function checkHooks(file: string, text: string): void {
  const hooks = HooksFile.parse(JSON.parse(text)).hooks ?? {};
  for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest'] as const) {
    for (const group of hooks[event] ?? []) {
      if (!group.matcher || group.matcher === '*') fail('tools', file, `${event} hook with no matcher`);
    }
  }
}

const catalog = path.join(root, '.claude-plugin', 'marketplace.json');
for (const entry of Catalog.parse(JSON.parse(fs.readFileSync(catalog, 'utf8'))).plugins ?? []) {
  if (typeof entry.source !== 'string') fail('format', catalog, `${entry.name} is not under plugins/`);
}
const dirs = args.named.length
  ? args.named.map((d) => path.resolve(d))
  : fs.readdirSync(path.join(root, 'plugins')).map((d) => path.join(root, 'plugins', d));
for (const dir of dirs) if (fs.statSync(dir).isDirectory()) checkPlugin(dir);
if (!args.named.length) {
  for (const tree of ['scripts', path.join('.claude', 'skills')]) {
    const dir = path.join(root, tree);
    if (fs.existsSync(dir)) for (const file of walk(dir)) checkTech(file);
  }
  checkSkills(path.join(root, '.claude', 'skills'));
  const agents = path.join(root, '.claude', 'agents');
  if (fs.existsSync(agents)) for (const file of walk(agents)) if (file.endsWith('.md')) checkAgent(file, fail);
}
process.exit(fails ? 1 : 0);
