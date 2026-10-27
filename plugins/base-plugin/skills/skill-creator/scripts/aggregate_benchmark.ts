#!/usr/bin/env node
/**
 * @file Aggregates grading.json runs into benchmark.json and benchmark.md with per-config stats and skill deltas
 * @tags skill-creator, benchmark, evals
 * @related plugins/base-plugin/skills/skill-creator/references/schemas.md
 */
// Aggregate individual run results into benchmark summary statistics.
//
// Reads grading.json files from run directories and produces:
// - run_summary with mean, stddev, min, max for each metric
// - delta between with_skill and without_skill configurations
//
// Usage:
//     node aggregate_benchmark.ts <benchmark_dir>
//
// Example:
//     node aggregate_benchmark.ts benchmarks/2026-01-15T10-30-00/
//
// The script supports two directory layouts:
//
//     Workspace layout (from skill-creator iterations):
//     <benchmark_dir>/
//     └── eval-N/
//         ├── with_skill/
//         │   ├── run-1/grading.json
//         │   └── run-2/grading.json
//         └── without_skill/
//             ├── run-1/grading.json
//             └── run-2/grading.json
//
//     Legacy layout (with runs/ subdirectory):
//     <benchmark_dir>/
//     └── runs/
//         └── eval-N/
//             ├── with_skill/
//             │   └── run-1/grading.json
//             └── without_skill/
//                 └── run-1/grading.json

import fs from 'node:fs';
import { z } from '../vendor/zod.generated.js';
import { aggregateResults } from './benchmark_stats.ts';
import type { RunResult } from './benchmark_stats.ts';
import { loadRunResults, log } from './benchmark_load.ts';
import { generateMarkdown } from './benchmark_md.ts';
import { parseArgv, pyJoin } from './cli.ts';
import { dumpJson, num, PyFloat, pyFixed, pyTitle } from './py_json.ts';
import { Benchmark, check } from './schemas.ts';
import type { ConfigSummary } from './schemas.ts';
import { isMain, runCli } from './utils.ts';

const PROG = 'aggregate_benchmark.ts';

const HELP = `usage: ${PROG} [-h] [--skill-name SKILL_NAME]
                              [--skill-path SKILL_PATH] [--output OUTPUT]
                              benchmark_dir

Aggregate benchmark run results into summary statistics

positional arguments:
  benchmark_dir         Path to the benchmark directory

options:
  -h, --help            show this help message and exit
  --skill-name SKILL_NAME
                        Name of the skill being benchmarked
  --skill-path SKILL_PATH
                        Path to the skill being benchmarked
  --output, -o OUTPUT   Output path for benchmark.json (default:
                        <benchmark_dir>/benchmark.json)
`;

/** Generate complete benchmark.json from run results. */
export function generateBenchmark(benchmarkDir: string, skillName = '', skillPath = ''): Benchmark {
  const results = loadRunResults(benchmarkDir);
  const runSummary = aggregateResults(results);

  // Build runs array for benchmark.json
  const runs: Benchmark['runs'] = [];
  for (const [config, configRuns] of results) {
    for (const result of configRuns) {
      runs.push({
        eval_id: result.eval_id,
        configuration: config,
        run_number: result.run_number,
        result: {
          pass_rate: result.pass_rate,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          time_seconds: result.time_seconds,
          tokens: result.tokens,
          tool_calls: result.tool_calls,
          errors: result.errors,
        },
        expectations: result.expectations,
        notes: result.notes,
      });
    }
  }

  // Determine eval IDs from results (set semantics, sorted)
  const key = (id: RunResult['eval_id']) => (id instanceof PyFloat ? id.value : id);
  const unique = new Map<unknown, RunResult['eval_id']>();
  for (const configRuns of results.values()) {
    for (const r of configRuns) if (!unique.has(key(r.eval_id))) unique.set(key(r.eval_id), r.eval_id);
  }
  const evalIds = [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  return check(
    Benchmark,
    {
      metadata: {
        skill_name: skillName || '<skill-name>',
        skill_path: skillPath || '<path/to/skill>',
        executor_model: '<model-name>',
        analyzer_model: '<model-name>',
        timestamp: new Date().toISOString().slice(0, 19) + 'Z',
        evals_run: evalIds,
        runs_per_configuration: 3,
      },
      runs,
      run_summary: runSummary,
      notes: [], // To be filled by analyzer
    },
    'benchmark',
  );
}

/** Python Path.with_suffix('.md'). */
function withMdSuffix(file: string): string {
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  const stem = dot > slash + 1 && dot < file.length - 1 ? file.slice(0, dot) : file;
  return `${stem}.md`;
}

const Args = z.object({
  skill_name: z.string(),
  skill_path: z.string(),
  output: z.string().nullable(),
  benchmark_dir: z.string(),
});

function main() {
  const args = check(
    Args,
    parseArgv(process.argv.slice(2), {
      prog: PROG,
      help: HELP,
      options: [
        { flags: ['--skill-name'], default: '' },
        { flags: ['--skill-path'], default: '' },
        { flags: ['--output', '-o'], type: 'path' },
      ],
      positionals: [{ dest: 'benchmark_dir', type: 'path' }],
    }),
    'arguments',
  );
  const benchmarkDir = args.benchmark_dir;

  if (!fs.existsSync(benchmarkDir)) {
    log(`Directory not found: ${benchmarkDir}`);
    process.exit(1);
  }

  const benchmark = generateBenchmark(benchmarkDir, args.skill_name, args.skill_path);

  // Determine output paths
  const outputJson = args.output || pyJoin(benchmarkDir, 'benchmark.json');
  const outputMd = withMdSuffix(outputJson);

  fs.writeFileSync(outputJson, dumpJson(benchmark, 2));
  log(`Generated: ${outputJson}`);

  fs.writeFileSync(outputMd, generateMarkdown(benchmark));
  log(`Generated: ${outputMd}`);

  // Print summary
  const runSummary = benchmark.run_summary as Record<string, ConfigSummary>;
  const configs = Object.keys(runSummary).filter((k) => k !== 'delta');

  log('\nSummary:');
  for (const config of configs) {
    const pr = num(runSummary[config].pass_rate.mean);
    const label = pyTitle(config.replaceAll('_', ' '));
    log(`  ${label}: ${pyFixed(pr * 100, 1)}% pass rate`);
  }
  log(`  Delta:         ${benchmark.run_summary.delta?.pass_rate ?? '—'}`);
}

if (isMain(import.meta.url)) await runCli(main);
