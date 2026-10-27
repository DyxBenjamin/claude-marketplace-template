/**
 * @file Discovers eval runs in a workspace and renders them into the standalone review page; exports findRuns, generateHtml
 * @tags skill-creator, eval-viewer
 * @related plugins/base-plugin/skills/skill-creator/references/schemas.md
 */
// Discovers eval runs in a workspace and renders them into the standalone review page.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyJoin } from '../scripts/cli.ts';
import { dumpJson, JSONDecodeError, num, truthy } from '../scripts/py_json.ts';
import { Benchmark, check, EmbeddedData, EvalMetadata, FeedbackFile, Grading } from '../scripts/schemas.ts';
import type { OutputFile, ViewerRun } from '../scripts/schemas.ts';
import { isDir, isFile, readBytes, readJson, readText } from '../scripts/utils.ts';
import { guessType } from './mime_types.ts';

// Files to exclude from output listings
const METADATA_FILES = new Set(['transcript.md', 'user_notes.md', 'metrics.json']);

// Extensions we render as inline text
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.py', '.js', '.ts', '.tsx', '.jsx',
  '.yaml', '.yml', '.xml', '.html', '.css', '.sh', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.r', '.toml',
]);

// Extensions we render as inline images
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

// MIME type overrides for common types
const MIME_OVERRIDES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'skill', 'inputs']);

export type Previous = Map<string, { feedback: string; outputs: OutputFile[] }>;

const sortedNames = (dir: string): string[] => fs.readdirSync(dir).sort();
const isReadError = (err: unknown): boolean => err instanceof JSONDecodeError || Boolean((err as NodeJS.ErrnoException).code);

/** Path.suffix: extension of the last component, '' for dotfiles and trailing dots. */
function suffix(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

function getMimeType(file: string): string {
  const ext = suffix(path.basename(file)).toLowerCase();
  return MIME_OVERRIDES[ext] ?? guessType(file) ?? 'application/octet-stream';
}

// Python tuple-key ordering: numbers numerically, strings by code point, null equal to null.
function compareKeys(a: ViewerRun['eval_id'] | string, b: ViewerRun['eval_id'] | string): number {
  const kind = (v: unknown) => (v === null ? 'none' : typeof v === 'string' ? 'str' : 'num');
  if (kind(a) !== kind(b)) throw new TypeError(`'<' not supported between instances of '${kind(a)}' and '${kind(b)}'`);
  if (kind(a) === 'none') return 0;
  const [x, y] = kind(a) === 'num' ? [num(a as number), num(b as number)] : [a as string, b as string];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Recursively find directories that contain an outputs/ subdirectory. */
export function findRuns(workspace: string): ViewerRun[] {
  const runs: ViewerRun[] = [];
  findRunsRecursive(workspace, workspace, runs);
  runs.sort((a, b) => compareKeys(a.eval_id, b.eval_id) || compareKeys(a.id, b.id));
  return runs;
}

function findRunsRecursive(root: string, current: string, runs: ViewerRun[]): void {
  if (!isDir(current)) return;

  if (isDir(pyJoin(current, 'outputs'))) {
    runs.push(buildRun(root, current));
    return;
  }

  for (const name of sortedNames(current)) {
    const child = pyJoin(current, name);
    if (isDir(child) && !SKIP_DIRS.has(name)) findRunsRecursive(root, child, runs);
  }
}

/** Build a run dict with prompt, outputs, and grading data. */
function buildRun(root: string, runDir: string): ViewerRun {
  const parent = path.dirname(runDir);
  let prompt = '';
  let evalId: ViewerRun['eval_id'] = null;

  // Try eval_metadata.json
  for (const candidate of [pyJoin(runDir, 'eval_metadata.json'), pyJoin(parent, 'eval_metadata.json')]) {
    if (fs.existsSync(candidate)) {
      try {
        const metadata = readJson(EvalMetadata, candidate);
        prompt = metadata.prompt ?? '';
        evalId = metadata.eval_id ?? null;
      } catch (err) {
        if (!isReadError(err)) throw err;
      }
      if (truthy(prompt)) break;
    }
  }

  // Fall back to transcript.md
  if (!truthy(prompt)) {
    for (const candidate of [pyJoin(runDir, 'transcript.md'), pyJoin(pyJoin(runDir, 'outputs'), 'transcript.md')]) {
      if (fs.existsSync(candidate)) {
        try {
          const match = /## Eval Prompt\n\n([\s\S]*?)(?=\n##|$)/.exec(readText(candidate));
          if (match) prompt = match[1].trim();
        } catch (err) {
          if (!(err as NodeJS.ErrnoException).code) throw err;
        }
        if (truthy(prompt)) break;
      }
    }
  }

  if (!truthy(prompt)) prompt = '(No prompt found)';

  const runId = (path.relative(root, runDir) || '.').replaceAll('/', '-').replaceAll('\\', '-');

  // Collect output files
  const outputsDir = pyJoin(runDir, 'outputs');
  const outputFiles: OutputFile[] = [];
  if (isDir(outputsDir)) {
    for (const name of sortedNames(outputsDir)) {
      const file = pyJoin(outputsDir, name);
      if (isFile(file) && !METADATA_FILES.has(name)) outputFiles.push(embedFile(file));
    }
  }

  // Load grading if present
  let grading: ViewerRun['grading'] = null;
  for (const candidate of [pyJoin(runDir, 'grading.json'), pyJoin(parent, 'grading.json')]) {
    if (fs.existsSync(candidate)) {
      try {
        grading = readJson(Grading, candidate);
      } catch (err) {
        if (!isReadError(err)) throw err;
      }
      if (truthy(grading)) break;
    }
  }

  return { id: runId, prompt, eval_id: evalId, outputs: outputFiles, grading };
}

/** Read a file and return an embedded representation. */
function embedFile(file: string): OutputFile {
  const name = path.basename(file);
  const ext = suffix(name).toLowerCase();
  const mime = getMimeType(file);

  if (TEXT_EXTENSIONS.has(ext)) {
    let content: string;
    try {
      content = readText(file);
    } catch {
      content = '(Error reading file)';
    }
    return { name, type: 'text', content };
  }

  let b64: string;
  try {
    b64 = readBytes(file).toString('base64');
  } catch {
    return { name, type: 'error', content: '(Error reading file)' };
  }
  if (IMAGE_EXTENSIONS.has(ext)) return { name, type: 'image', mime, data_uri: `data:${mime};base64,${b64}` };
  if (ext === '.pdf') return { name, type: 'pdf', data_uri: `data:${mime};base64,${b64}` };
  if (ext === '.xlsx') return { name, type: 'xlsx', data_b64: b64 };
  // Binary / unknown: base64 download link
  return { name, type: 'binary', mime, data_uri: `data:${mime};base64,${b64}` };
}

/** Reads a benchmark.json for the Benchmark tab; a missing or unparsable file yields null. */
export function loadBenchmark(file: string | null): Benchmark | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return readJson(Benchmark, file);
  } catch (err) {
    if (!isReadError(err)) throw err;
    return null;
  }
}

/** Load previous iteration's feedback and outputs, keyed by run_id. */
export function loadPreviousIteration(workspace: string): Previous {
  const result: Previous = new Map();

  // Load feedback
  const feedbackMap = new Map<string, string>();
  const feedbackPath = pyJoin(workspace, 'feedback.json');
  if (fs.existsSync(feedbackPath)) {
    try {
      for (const r of readJson(FeedbackFile, feedbackPath).reviews) {
        if (r.feedback.trim()) feedbackMap.set(r.run_id, r.feedback);
      }
    } catch (err) {
      if (!isReadError(err)) throw err;
    }
  }

  // Load runs (to get outputs)
  for (const run of findRuns(workspace)) {
    result.set(run.id, { feedback: feedbackMap.get(run.id) ?? '', outputs: run.outputs });
  }

  // Also add feedback for run_ids that had feedback but no matching run
  for (const [runId, fb] of feedbackMap) {
    if (!result.has(runId)) result.set(runId, { feedback: fb, outputs: [] });
  }

  return result;
}

/** Generate the complete standalone HTML page with embedded data. */
export function generateHtml(runs: ViewerRun[], skillName: string, previous: Previous | null = null, benchmark: Benchmark | null = null): string {
  const template = readText(path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.html'));

  // Build previous_feedback and previous_outputs maps for the template
  const previousFeedback = new Map<string, string>();
  const previousOutputs = new Map<string, OutputFile[]>();
  if (previous) {
    for (const [runId, data] of previous) {
      if (truthy(data.feedback)) previousFeedback.set(runId, data.feedback);
      if (truthy(data.outputs)) previousOutputs.set(runId, data.outputs);
    }
  }

  const embedded: Record<string, unknown> = {
    skill_name: skillName,
    runs,
    previous_feedback: previousFeedback,
    previous_outputs: previousOutputs,
  };
  if (truthy(benchmark)) embedded.benchmark = benchmark;

  const dataJson = dumpJson(check(EmbeddedData, embedded, 'viewer data'));
  return template.replaceAll('/*__EMBEDDED_DATA__*/', () => `const EMBEDDED_DATA = ${dataJson};`);
}
