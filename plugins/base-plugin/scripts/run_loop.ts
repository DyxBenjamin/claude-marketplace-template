#!/usr/bin/env node
/**
 * @file Alternates trigger evals and description rewrites over a seeded train/test split; exports runLoop, splitEvalSet
 * @tags skill-creator, description-optimization, evals
 * @related plugins/base-plugin/scripts/run_eval.ts, plugins/base-plugin/scripts/improve_description.ts
 */
// Run the eval + improve loop until all pass or max iterations reached.
//
// Combines run_eval.ts and improve_description.ts in a loop, tracking history
// and returning the best description found. Supports train/test split to prevent
// overfitting.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';
import { formatHelp, parseArgv } from './cli.ts';
import type { CliOption } from './cli.ts';
import { improveDescription } from './improve_description.ts';
import { dumpJson, PyFloat, pyStr } from './py_json.ts';
import { Random } from './py_random.ts';
import { findProjectRoot, runEval } from './run_eval.ts';
import { check, LoopOutput, TriggerEvalSet } from './schemas.ts';
import type { HistoryAttempt, TriggerQuery, TriggerResult } from './schemas.ts';
import { cut, isMain, loadJson, parseSkillMd, pct, runCli } from './utils.ts';

/** Splits the eval set into [train, test], stratified by should_trigger. */
export function splitEvalSet(evalSet: TriggerQuery[], holdout: number, seed = 42): [TriggerQuery[], TriggerQuery[]] {
  const rng = new Random(seed);

  const trigger = evalSet.filter((e) => e.should_trigger);
  const noTrigger = evalSet.filter((e) => !e.should_trigger);

  rng.shuffle(trigger);
  rng.shuffle(noTrigger);

  const nTriggerTest = Math.max(1, Math.trunc(trigger.length * holdout));
  const nNoTriggerTest = Math.max(1, Math.trunc(noTrigger.length * holdout));

  const testSet = [...trigger.slice(0, nTriggerTest), ...noTrigger.slice(0, nNoTriggerTest)];
  const trainSet = [...trigger.slice(nTriggerTest), ...noTrigger.slice(nNoTriggerTest)];

  return [trainSet, testSet];
}

type Summary = { passed: number; failed: number; total: number };

const summarize = (results: TriggerResult[]): Summary => {
  const passed = results.filter((r) => r.pass).length;
  return { passed, failed: results.length - passed, total: results.length };
};

function printEvalStats(label: string, results: TriggerResult[], elapsed: number): void {
  const pos = results.filter((r) => r.should_trigger);
  const neg = results.filter((r) => !r.should_trigger);
  const tp = pos.reduce((n, r) => n + r.triggers, 0);
  const fn = pos.reduce((n, r) => n + r.runs, 0) - tp;
  const fp = neg.reduce((n, r) => n + r.triggers, 0);
  const tn = neg.reduce((n, r) => n + r.runs, 0) - fp;
  const total = tp + tn + fp + fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;
  const accuracy = total > 0 ? (tp + tn) / total : 0.0;
  console.error(
    `${label}: ${tp + tn}/${total} correct, precision=${pct(precision)} recall=${pct(recall)} accuracy=${pct(accuracy)} (${elapsed.toFixed(1)}s)`,
  );
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    console.error(`  [${status}] rate=${r.triggers}/${r.runs} expected=${pyStr(r.should_trigger)}: ${cut(r.query, 60)}`);
  }
}

type GenerateHtml = (data: LoopOutput, autoRefresh?: boolean, skillName?: string) => string;

const seconds = () => performance.now() / 1000;

type Entry = HistoryAttempt & {
  iteration: number;
  train_passed: number;
  train_failed: number;
  train_total: number;
  train_results: TriggerResult[];
  test_passed: number | null;
  test_failed: number | null;
  test_total: number | null;
  test_results: TriggerResult[] | null;
};

export type RunLoopOptions = {
  evalSet: TriggerQuery[];
  skillPath: string;
  descriptionOverride: string | null;
  numWorkers: number;
  timeout: number;
  maxIterations: number;
  runsPerQuery: number;
  triggerThreshold: number;
  holdout: number;
  model: string;
  verbose: boolean;
  liveReportPath?: string | null;
  logDir?: string | null;
};

/**
 * Runs the eval + improvement loop and resolves to the result object.
 * Report rendering uses generateHtml from ./generate_report.ts when liveReportPath is set.
 */
export async function runLoop({
  evalSet,
  skillPath,
  descriptionOverride,
  numWorkers,
  timeout,
  maxIterations,
  runsPerQuery,
  triggerThreshold,
  holdout,
  model,
  verbose,
  liveReportPath = null,
  logDir = null,
}: RunLoopOptions): Promise<LoopOutput> {
  const projectRoot = findProjectRoot();
  const [name, originalDescription, content] = parseSkillMd(skillPath);
  let currentDescription = descriptionOverride || originalDescription;

  let trainSet: TriggerQuery[];
  let testSet: TriggerQuery[];
  if (holdout > 0) {
    [trainSet, testSet] = splitEvalSet(evalSet, holdout);
    if (verbose) console.error(`Split: ${trainSet.length} train, ${testSet.length} test (holdout=${holdout})`);
  } else {
    trainSet = evalSet;
    testSet = [];
  }

  const generateHtml = liveReportPath ? (await import('./generate_report.ts')).generateHtml : null;
  const history: Entry[] = [];
  let exitReason = 'unknown';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (verbose) {
      console.error(`\n${'='.repeat(60)}`);
      console.error(`Iteration ${iteration}/${maxIterations}`);
      console.error(`Description: ${currentDescription}`);
      console.error('='.repeat(60));
    }

    // Evaluate train + test together in one batch for parallelism
    const allQueries = [...trainSet, ...testSet];
    let t0 = seconds();
    const allResults = await runEval({
      evalSet: allQueries,
      skillName: name,
      description: currentDescription,
      numWorkers,
      timeout,
      projectRoot,
      runsPerQuery,
      triggerThreshold,
      model,
    });
    const evalElapsed = seconds() - t0;

    // Split results back into train/test by matching queries
    const trainQueries = new Set(trainSet.map((q) => q.query));
    const trainResultList = allResults.results.filter((r) => trainQueries.has(r.query));
    const testResultList = allResults.results.filter((r) => !trainQueries.has(r.query));

    const trainSummary = summarize(trainResultList);
    const testSummary = testSet.length ? summarize(testResultList) : null;

    history.push({
      iteration,
      description: currentDescription,
      train_passed: trainSummary.passed,
      train_failed: trainSummary.failed,
      train_total: trainSummary.total,
      train_results: trainResultList,
      test_passed: testSummary ? testSummary.passed : null,
      test_failed: testSummary ? testSummary.failed : null,
      test_total: testSummary ? testSummary.total : null,
      test_results: testSummary ? testResultList : null,
      passed: trainSummary.passed,
      failed: trainSummary.failed,
      total: trainSummary.total,
      results: trainResultList,
    });

    // Write live report if path provided
    if (liveReportPath) {
      const partialOutput = check(
        LoopOutput,
        {
          original_description: originalDescription,
          best_description: currentDescription,
          best_score: 'in progress',
          iterations_run: history.length,
          holdout: new PyFloat(holdout),
          train_size: trainSet.length,
          test_size: testSet.length,
          history,
        },
        'run_loop report data',
      );
      fs.writeFileSync(liveReportPath, (generateHtml as GenerateHtml)(partialOutput, true, name));
    }

    if (verbose) {
      printEvalStats('Train', trainResultList, evalElapsed);
      if (testSummary) printEvalStats('Test ', testResultList, 0);
    }

    if (trainSummary.failed === 0) {
      exitReason = `all_passed (iteration ${iteration})`;
      if (verbose) console.error(`\nAll train queries passed on iteration ${iteration}!`);
      break;
    }

    if (iteration === maxIterations) {
      exitReason = `max_iterations (${maxIterations})`;
      if (verbose) console.error(`\nMax iterations reached (${maxIterations}).`);
      break;
    }

    // Improve the description based on train results
    if (verbose) console.error('\nImproving description...');

    t0 = seconds();
    // Strip test scores from history so the improvement model can't see them
    const blindedHistory = history.map((h) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith('test_')))) as HistoryAttempt[];
    const newDescription = improveDescription({
      skillName: name,
      skillContent: content,
      currentDescription,
      evalResults: { results: trainResultList, summary: trainSummary },
      history: blindedHistory,
      model,
      logDir,
      iteration,
    });
    const improveElapsed = seconds() - t0;

    if (verbose) console.error(`Proposed (${improveElapsed.toFixed(1)}s): ${newDescription}`);

    currentDescription = newDescription;
  }

  // Find the best iteration by TEST score (or train if no test set)
  const scoreKey = testSet.length ? 'test_passed' : 'train_passed';
  const best = history.reduce((a, h) => ((h[scoreKey] || 0) > (a[scoreKey] || 0) ? h : a));
  const bestScore = testSet.length ? `${best.test_passed}/${best.test_total}` : `${best.train_passed}/${best.train_total}`;

  if (verbose) {
    console.error(`\nExit reason: ${exitReason}`);
    console.error(`Best score: ${bestScore} (iteration ${best.iteration})`);
  }

  return check(
    LoopOutput,
    {
      exit_reason: exitReason,
      original_description: originalDescription,
      best_description: best.description,
      best_score: bestScore,
      best_train_score: `${best.train_passed}/${best.train_total}`,
      best_test_score: testSet.length ? `${best.test_passed}/${best.test_total}` : null,
      final_description: currentDescription,
      iterations_run: history.length,
      holdout: new PyFloat(holdout),
      train_size: trainSet.length,
      test_size: testSet.length,
      history,
    },
    'run_loop results',
  );
}

const pad = (n: number): string => String(n).padStart(2, '0');

function timestamp(sep: boolean): string {
  const d = new Date();
  const date = `${d.getFullYear()}${sep ? '-' : ''}${pad(d.getMonth() + 1)}${sep ? '-' : ''}${pad(d.getDate())}`;
  return `${date}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function openInBrowser(file: string): void {
  const [cmd, ...args]: string[] =
    process.platform === 'darwin' ? ['open', file] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', file] : ['xdg-open', file];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

const PROG = 'run_loop.ts';
const OPTIONS: CliOption[] = [
  { flags: ['--eval-set'], type: 'str', required: true, help: 'Path to eval set JSON file' },
  { flags: ['--skill-path'], type: 'str', required: true, help: 'Path to skill directory' },
  { flags: ['--description'], type: 'str', help: 'Override starting description' },
  { flags: ['--num-workers'], type: 'int', default: 10, help: 'Number of parallel workers' },
  { flags: ['--timeout'], type: 'int', default: 30, help: 'Timeout per query in seconds' },
  { flags: ['--max-iterations'], type: 'int', default: 5, help: 'Max improvement iterations' },
  { flags: ['--runs-per-query'], type: 'int', default: 3, help: 'Number of runs per query' },
  { flags: ['--trigger-threshold'], type: 'float', default: 0.5, help: 'Trigger rate threshold' },
  { flags: ['--holdout'], type: 'float', default: 0.4, help: 'Fraction of eval set to hold out for testing (0 to disable)' },
  { flags: ['--model'], type: 'str', required: true, help: 'Model for improvement' },
  { flags: ['--verbose'], type: 'bool', help: 'Print progress to stderr' },
  {
    flags: ['--report'],
    type: 'str',
    default: 'auto',
    help: "Generate HTML report at this path (default: 'auto' for temp file, 'none' to disable)",
  },
  {
    flags: ['--results-dir'],
    type: 'str',
    help: 'Save all outputs (results.json, report.html, log.txt) to a timestamped subdirectory here',
  },
];

const Args = z.object({
  eval_set: z.string(),
  skill_path: z.string(),
  description: z.string().nullable(),
  num_workers: z.number().int().positive(),
  timeout: z.number().int(),
  max_iterations: z.number().int().positive(),
  runs_per_query: z.number().int(),
  trigger_threshold: z.number(),
  holdout: z.number().min(0).max(1),
  model: z.string(),
  verbose: z.boolean(),
  report: z.string(),
  results_dir: z.string().nullable(),
});

async function main() {
  const help = formatHelp(PROG, 'Run eval + improve loop', OPTIONS);
  const args = check(Args, parseArgv(process.argv.slice(2), { prog: PROG, help, options: OPTIONS }), 'arguments');

  const evalSet = loadJson(TriggerEvalSet, args.eval_set);
  const skillPath = args.skill_path;
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const [name] = parseSkillMd(skillPath);

  // Set up live report path
  let liveReportPath: string | null = null;
  if (args.report !== 'none') {
    liveReportPath =
      args.report === 'auto'
        ? path.join(os.tmpdir(), `skill_description_report_${(path.basename(path.normalize(skillPath)) === '.' ? '' : path.basename(path.normalize(skillPath)))}_${timestamp(false)}.html`)
        : args.report;
    // Open the report immediately so the user can watch
    fs.writeFileSync(
      liveReportPath,
      "<html><body><h1>Starting optimization loop...</h1><meta http-equiv='refresh' content='5'></body></html>",
    );
    openInBrowser(liveReportPath);
  }

  // Create the output directory before the loop so logs can be written
  let resultsDir: string | null = null;
  if (args.results_dir) {
    resultsDir = path.join(args.results_dir, timestamp(true));
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const output = await runLoop({
    evalSet,
    skillPath,
    descriptionOverride: args.description,
    numWorkers: args.num_workers,
    timeout: args.timeout,
    maxIterations: args.max_iterations,
    runsPerQuery: args.runs_per_query,
    triggerThreshold: args.trigger_threshold,
    holdout: args.holdout,
    model: args.model,
    verbose: args.verbose,
    liveReportPath,
    logDir: resultsDir ? path.join(resultsDir, 'logs') : null,
  });

  const jsonOutput = dumpJson(output, 2);
  console.log(jsonOutput);
  if (resultsDir) fs.writeFileSync(path.join(resultsDir, 'results.json'), jsonOutput);

  // Write final HTML report (without auto-refresh)
  if (liveReportPath) {
    const { generateHtml } = await import('./generate_report.ts');
    const html = generateHtml(output, false, name);
    fs.writeFileSync(liveReportPath, html);
    console.error(`\nReport: ${liveReportPath}`);
    if (resultsDir) fs.writeFileSync(path.join(resultsDir, 'report.html'), html);
  }

  if (resultsDir) console.error(`Results saved to: ${resultsDir}`);
}

if (isMain(import.meta.url)) await runCli(main);
