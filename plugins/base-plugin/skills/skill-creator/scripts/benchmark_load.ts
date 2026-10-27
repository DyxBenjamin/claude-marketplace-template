/**
 * @file Discovers benchmark runs and loads grading, timing and eval metadata per run; exports loadRunResults and log.
 * @tags skill-creator, benchmark, evals
 * @related plugins/base-plugin/skills/skill-creator/scripts/aggregate_benchmark.ts, plugins/base-plugin/skills/skill-creator/scripts/benchmark_stats.ts, plugins/base-plugin/skills/skill-creator/references/schemas.md
 */
import fs from 'node:fs';
import { pyJoin } from './cli.ts';
import { JSONDecodeError, num, pyRepr, truthy } from './py_json.ts';
import { EvalMetadata, Grading, SchemaError, Timing } from './schemas.ts';
import { ZERO } from './benchmark_stats.ts';
import type { RunResult } from './benchmark_stats.ts';
import { isDir, readJson } from './utils.ts';

export const log = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const names = (dir: string, prefix: string): string[] => fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();

function pyInt(text: string): number {
  if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(text)) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyRepr(text)}`);
  return parseInt(text.replaceAll('_', ''), 10);
}

const isFsError = (err: unknown): boolean => Boolean((err as NodeJS.ErrnoException).code);

// Evals are identified by eval_metadata.json, else by the number in the directory name, else by position.
function evalIdOf(evalDir: string, evalName: string, evalIdx: number): RunResult['eval_id'] {
  const metadataPath = pyJoin(evalDir, 'eval_metadata.json');
  if (!fs.existsSync(metadataPath)) {
    try {
      return pyInt(evalName.split('-')[1]);
    } catch {
      return evalIdx;
    }
  }
  try {
    return readJson(EvalMetadata, metadataPath).eval_id ?? evalIdx;
  } catch (err) {
    if (err instanceof SchemaError) log(`Warning: ${err.message}`);
    else if (!(err instanceof JSONDecodeError || isFsError(err))) throw err;
    return evalIdx;
  }
}

function readRun(runDir: string, runName: string, evalId: RunResult['eval_id']): RunResult | null {
  const gradingFile = pyJoin(runDir, 'grading.json');
  if (!fs.existsSync(gradingFile)) {
    log(`Warning: grading.json not found in ${runDir}`);
    return null;
  }

  let grading;
  try {
    grading = readJson(Grading, gradingFile);
  } catch (err) {
    if (err instanceof JSONDecodeError) log(`Warning: Invalid JSON in ${gradingFile}: ${err.message}`);
    else if (err instanceof SchemaError) log(`Warning: ${err.message}`);
    else throw err;
    return null;
  }

  const summary = grading.summary ?? {};
  const metrics = grading.execution_metrics ?? {};
  const result: RunResult = {
    eval_id: evalId,
    run_number: pyInt(runName.split('-')[1]),
    pass_rate: summary.pass_rate ?? ZERO,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    total: summary.total ?? 0,
    // Timing comes from grading.json first, then the sibling timing.json
    time_seconds: grading.timing?.total_duration_seconds ?? ZERO,
    tokens: 0,
    tool_calls: metrics.total_tool_calls ?? 0,
    errors: metrics.errors_encountered ?? 0,
    expectations: [],
    notes: [],
  };

  const timingFile = pyJoin(runDir, 'timing.json');
  if (num(result.time_seconds) === 0 && fs.existsSync(timingFile)) {
    try {
      const timing = readJson(Timing, timingFile);
      result.time_seconds = timing.total_duration_seconds ?? ZERO;
      result.tokens = timing.total_tokens ?? 0;
    } catch (err) {
      if (err instanceof SchemaError) log(`Warning: ${err.message}`);
      else if (!(err instanceof JSONDecodeError)) throw err;
    }
  }
  if (!truthy(result.tokens)) result.tokens = metrics.output_chars ?? 0;

  // The viewer requires text, passed, evidence
  result.expectations = grading.expectations ?? [];
  for (const exp of result.expectations) {
    if (exp.text === undefined || exp.passed === undefined) {
      log(`Warning: expectation in ${gradingFile} missing required fields (text, passed, evidence): ${pyRepr(exp)}`);
    }
  }

  const notes = grading.user_notes_summary ?? {};
  result.notes = [...(notes.uncertainties ?? []), ...(notes.needs_review ?? []), ...(notes.workarounds ?? [])];
  return result;
}

/**
 * Load all run results from a benchmark directory.
 *
 * Returns a Map keyed by config name (e.g. "with_skill"/"without_skill",
 * or "new_skill"/"old_skill"), each containing a list of run results.
 */
export function loadRunResults(benchmarkDir: string): Map<string, RunResult[]> {
  // Support both layouts: eval dirs directly under benchmarkDir, or under runs/
  const runsDir = pyJoin(benchmarkDir, 'runs');
  let searchDir: string;
  if (fs.existsSync(runsDir)) {
    searchDir = runsDir;
  } else if (names(benchmarkDir, 'eval-').length) {
    searchDir = benchmarkDir;
  } else {
    log(`No eval directories found in ${benchmarkDir} or ${runsDir}`);
    return new Map();
  }

  const results = new Map<string, RunResult[]>();

  names(searchDir, 'eval-').forEach((evalName, evalIdx) => {
    const evalDir = pyJoin(searchDir, evalName);
    const evalId = evalIdOf(evalDir, evalName, evalIdx);

    // Discover config directories dynamically rather than hardcoding names
    for (const configName of fs.readdirSync(evalDir).sort()) {
      const configDir = pyJoin(evalDir, configName);
      if (!isDir(configDir)) continue;
      // Skip non-config directories (inputs, outputs, etc.)
      const runNames = names(configDir, 'run-');
      if (!runNames.length) continue;
      if (!results.has(configName)) results.set(configName, []);

      for (const runName of runNames) {
        const run = readRun(pyJoin(configDir, runName), runName, evalId);
        if (run) results.get(configName)?.push(run);
      }
    }
  });

  return results;
}
