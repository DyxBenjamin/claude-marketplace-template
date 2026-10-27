/**
 * @file Computes per-configuration run statistics and config deltas; exports calculateStats, aggregateResults, RunResult.
 * @tags skill-creator, benchmark, evals
 * @related plugins/base-plugin/skills/skill-creator/scripts/aggregate_benchmark.ts, plugins/base-plugin/skills/skill-creator/scripts/schemas.ts
 */
import { num, PyFloat, pyFixedSigned, pyRound, pySum } from './py_json.ts';
import type { PyNum } from './py_json.ts';
import type { ConfigSummary, Stat } from './schemas.ts';

export const ZERO = new PyFloat(0);

/** One run's numbers as read from its grading.json and timing.json. */
export type RunResult = {
  eval_id: PyNum | string;
  run_number: number;
  pass_rate: PyNum;
  passed: PyNum;
  failed: PyNum;
  total: PyNum;
  time_seconds: PyNum;
  tokens: PyNum;
  tool_calls: PyNum;
  errors: PyNum;
  expectations: Record<string, unknown>[];
  notes: string[];
};

export type Metric = 'pass_rate' | 'time_seconds' | 'tokens';

export type RunSummary = Record<string, ConfigSummary | { pass_rate: string; time_seconds: string; tokens: string }>;

/** Calculate mean, stddev, min, max for a list of values. */
export function calculateStats(values: PyNum[]): Stat {
  if (!values.length) return { mean: ZERO, stddev: ZERO, min: ZERO, max: ZERO };

  const nums = values.map(num);
  const n = nums.length;
  const mean = pySum(values) / n;

  let stddev = 0;
  if (n > 1) {
    const variance = pySum(nums.map((x) => new PyFloat((x - mean) * (x - mean)))) / (n - 1);
    stddev = Math.sqrt(variance);
  }

  // min()/max() return the first extreme element, keeping its int or float type
  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (num(v) < num(lo)) lo = v;
    if (num(v) > num(hi)) hi = v;
  }
  const rounded = (v: PyNum): PyNum => (v instanceof PyFloat ? new PyFloat(pyRound(v.value, 4)) : v);
  return {
    mean: new PyFloat(pyRound(mean, 4)),
    stddev: new PyFloat(pyRound(stddev, 4)),
    min: rounded(lo),
    max: rounded(hi),
  };
}

/** Aggregate run results into run_summary: stats for each configuration plus the delta of the first two. */
export function aggregateResults(results: Map<string, RunResult[]>): RunSummary {
  const runSummary: RunSummary = {};
  const configs = [...results.keys()];

  for (const config of configs) {
    const runs = results.get(config) ?? [];

    if (!runs.length) {
      runSummary[config] = {
        pass_rate: { mean: ZERO, stddev: ZERO, min: ZERO, max: ZERO },
        time_seconds: { mean: ZERO, stddev: ZERO, min: ZERO, max: ZERO },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      };
      continue;
    }

    runSummary[config] = {
      pass_rate: calculateStats(runs.map((r) => r.pass_rate)),
      time_seconds: calculateStats(runs.map((r) => r.time_seconds)),
      tokens: calculateStats(runs.map((r) => r.tokens)),
    };
  }

  // Delta between the first two configs (if two exist)
  const primary = (configs.length ? runSummary[configs[0]] : undefined) as ConfigSummary | undefined;
  const baseline = (configs.length >= 2 ? runSummary[configs[1]] : undefined) as ConfigSummary | undefined;
  const mean = (summary: ConfigSummary | undefined, metric: Metric) => num(summary?.[metric]?.mean ?? 0);

  runSummary.delta = {
    pass_rate: pyFixedSigned(mean(primary, 'pass_rate') - mean(baseline, 'pass_rate'), 2),
    time_seconds: pyFixedSigned(mean(primary, 'time_seconds') - mean(baseline, 'time_seconds'), 1),
    tokens: pyFixedSigned(mean(primary, 'tokens') - mean(baseline, 'tokens'), 0),
  };

  return runSummary;
}
