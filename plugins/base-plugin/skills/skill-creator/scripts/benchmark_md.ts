/**
 * @file Renders benchmark data as a benchmark.md summary table of pass rate, time and tokens; exports generateMarkdown.
 * @tags skill-creator, benchmark
 * @related plugins/base-plugin/skills/skill-creator/scripts/aggregate_benchmark.ts, plugins/base-plugin/skills/skill-creator/scripts/schemas.ts
 */
import { num, pyFixed, pyStr, pyTitle } from './py_json.ts';
import type { Metric } from './benchmark_stats.ts';
import type { Benchmark, ConfigSummary } from './schemas.ts';

type Delta = { pass_rate?: string; time_seconds?: string; tokens?: string };

/** Generate human-readable benchmark.md from benchmark data. */
export function generateMarkdown(benchmark: Benchmark): string {
  const { metadata, run_summary: runSummary } = benchmark;

  // Config names (excluding "delta")
  const configs = Object.keys(runSummary).filter((k) => k !== 'delta');
  const configA = configs.length >= 1 ? configs[0] : 'config_a';
  const configB = configs.length >= 2 ? configs[1] : 'config_b';
  const labelA = pyTitle(configA.replaceAll('_', ' '));
  const labelB = pyTitle(configB.replaceAll('_', ' '));

  const lines = [
    `# Skill Benchmark: ${metadata.skill_name}`,
    '',
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${metadata.evals_run.map(pyStr).join(', ')} (${pyStr(metadata.runs_per_configuration)} runs each per configuration)`,
    '',
    '## Summary',
    '',
    `| Metric | ${labelA} | ${labelB} | Delta |`,
    '|--------|------------|---------------|-------|',
  ];

  const summaries = runSummary as Record<string, ConfigSummary | undefined>;
  const aSummary = summaries[configA];
  const bSummary = summaries[configB];
  const delta: Delta = runSummary.delta ?? {};
  const stat = (summary: ConfigSummary | undefined, metric: Metric, key: 'mean' | 'stddev') =>
    num(summary?.[metric]?.[key] ?? 0);

  // Format pass rate
  const pct = (summary: ConfigSummary | undefined, key: 'mean' | 'stddev') => pyFixed(stat(summary, 'pass_rate', key) * 100, 0);
  lines.push(
    `| Pass Rate | ${pct(aSummary, 'mean')}% ± ${pct(aSummary, 'stddev')}% | ${pct(bSummary, 'mean')}% ± ${pct(bSummary, 'stddev')}% | ${delta.pass_rate ?? '—'} |`,
  );

  // Format time
  const sec = (summary: ConfigSummary | undefined, key: 'mean' | 'stddev') => pyFixed(stat(summary, 'time_seconds', key), 1);
  lines.push(
    `| Time | ${sec(aSummary, 'mean')}s ± ${sec(aSummary, 'stddev')}s | ${sec(bSummary, 'mean')}s ± ${sec(bSummary, 'stddev')}s | ${delta.time_seconds ?? '—'}s |`,
  );

  // Format tokens
  const tok = (summary: ConfigSummary | undefined, key: 'mean' | 'stddev') => pyFixed(stat(summary, 'tokens', key), 0);
  lines.push(
    `| Tokens | ${tok(aSummary, 'mean')} ± ${tok(aSummary, 'stddev')} | ${tok(bSummary, 'mean')} ± ${tok(bSummary, 'stddev')} | ${delta.tokens ?? '—'} |`,
  );

  // Notes section
  if (benchmark.notes.length) {
    lines.push('', '## Notes', '');
    for (const note of benchmark.notes) lines.push(`- ${pyStr(note)}`);
  }

  return lines.join('\n');
}
