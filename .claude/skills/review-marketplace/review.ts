/**
 * @file Runs CI's marketplace checks locally: sync drift, strict validation, mod tests, plugin rules, typecheck, vendored zod, versions, names
 * @tags ci, validation, marketplace
 * @related scripts/generate-release-config.ts, .github/workflows/validate.yml, .claude/skills/review-marketplace/SKILL.md
 */
// Usage: review.ts [repo root]. Runs locally what CI checks, without changing the working tree.
// Prints one "FAIL <check>: <detail>" line per problem, "WARN" lines that do not fail, and "ok" when nothing
// failed; exits 1 on any failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const Args = z.object({ root: z.string().default('.') });
const PluginManifest = z.looseObject({ name: z.string() });
const Catalog = z.looseObject({
  plugins: z.array(z.looseObject({ name: z.string(), source: z.unknown() })).default([]),
});

const here = import.meta.dirname;
const args = Args.parse({ root: process.argv[2] });
const root = path.resolve(args.root);
try {
  process.chdir(root);
} catch {
  process.exit(2);
}
let fails = 0;
const fail = (check: string, detail: string): void => {
  console.log(`FAIL ${check}: ${detail}`);
  fails++;
};

// Runs a command with stderr merged into stdout, as `cmd 2>&1` does.
function run(cmd: string[], cwd = root): { ok: boolean; out: string } {
  const r = spawnSync('sh', ['-c', 'exec "$@" 2>&1', 'sh', ...cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { ok: r.status === 0, out: r.stdout };
}

const firstMatch = (out: string, re: RegExp): string => out.split('\n').find((l) => re.test(l)) ?? '';
const ERROR_LINE = /✘|error|Error/;

function listDirs(parent: string): string[] {
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && fs.statSync(path.join(parent, e.name), { throwIfNoEntry: false })?.isDirectory())
    .map((e) => e.name)
    .sort();
}

function hasTests(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && hasTests(full)) return true;
    } else if (/\.test\.tsx?$/.test(entry.name)) return true;
  }
  return false;
}

const catalogPath = path.join(root, '.claude-plugin', 'marketplace.json');
const catalog = Catalog.parse(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
const pluginDirs = listDirs(path.join(root, 'plugins')).map((d) => `plugins/${d}/`);

// Sync drift: run the sync script on a copy and compare the files it owns.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
try {
  fs.cpSync(root, tmp, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
  });
  if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'));
  if (!run(['node', path.join(tmp, 'scripts', 'generate-release-config.ts')]).ok) fail('sync', 'generate-release-config.ts failed');
  for (const f of ['.claude-plugin/marketplace.json', 'release-please-config.json', '.release-please-manifest.json']) {
    const mine = fs.existsSync(f) ? fs.readFileSync(f) : null;
    const theirs = fs.existsSync(path.join(tmp, f)) ? fs.readFileSync(path.join(tmp, f)) : null;
    if (!mine || !theirs || !mine.equals(theirs)) fail('sync', `${f} is out of date; run node scripts/generate-release-config.ts`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Strict validation of the catalog and each local plugin, as validate.yml does.
const market = run(['claude', 'plugin', 'validate', '.', '--strict']);
if (!market.ok) fail('validate', `marketplace: ${firstMatch(market.out, ERROR_LINE)}`);
for (const dir of pluginDirs) {
  if (!fs.existsSync(path.join(root, dir, '.claude-plugin', 'plugin.json'))) continue;
  const res = run(['claude', 'plugin', 'validate', dir, '--strict']);
  if (!res.ok) fail('validate', `${dir}: ${firstMatch(res.out, ERROR_LINE)}`);
}

// Mod tests, for every plugin that ships *.test.ts or *.test.tsx files.
for (const dir of pluginDirs) {
  if (!hasTests(path.join(root, dir))) continue;
  if (!run(['claude', 'plugin', 'test'], path.join(root, dir)).ok) fail('test', `${dir}: claude plugin test failed`);
}

// Plugin rules of rules.md that a script can decide: format, data, language, tone, technologies, tools.
const rules = spawnSync('node', [path.join(here, 'check-rules.ts'), root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
process.stdout.write(rules.stdout);
if (rules.status !== 0) fails++;

// Typecheck and vendored zod copies.
const types = run(['npx', '--no-install', 'tsc', '-p', '.']);
if (!types.ok) fail('typecheck', firstMatch(types.out, /error/) || types.out.trim().split('\n')[0]);
const vendor = run(['node', 'scripts/vendor-zod.ts', '--check']);
if (!vendor.ok) fail('vendor', vendor.out.trim().split('\n')[0]);

// Versions live only in plugin.json.
const versioned = catalog.plugins.filter((p) => 'version' in p);
for (const p of versioned) console.log(`FAIL version: marketplace entry ${p.name} declares a version; plugin.json owns it`);
if (versioned.length) fails++;

// Entry name equals the plugin.json name for every local plugin.
const mismatches: string[] = [];
for (const p of catalog.plugins) {
  if (typeof p.source !== 'string') continue;
  const manifest = path.join(path.dirname(catalogPath), '..', p.source, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    mismatches.push(`${p.name}: ${p.source} has no plugin.json`);
    continue;
  }
  const name = PluginManifest.parse(JSON.parse(fs.readFileSync(manifest, 'utf8'))).name;
  if (name !== p.name) mismatches.push(`${p.name}: plugin.json name is ${name}`);
}
for (const line of mismatches) console.log(`FAIL name: ${line}`);
if (mismatches.length) fails++;

// Placeholders left from the template: a warning, since the template itself keeps them on purpose.
const grep = run(['git', 'grep', '-l', 'CHANGE_ME', '--', ':!.claude/skills']);
const left = grep.ok ? grep.out.split('\n').filter(Boolean).map((f) => `${f} `).join('') : '';
if (left) console.log(`WARN placeholder: CHANGE_ME in ${left}`);

if (!fails) console.log('ok');
process.exit(fails ? 1 : 0);
