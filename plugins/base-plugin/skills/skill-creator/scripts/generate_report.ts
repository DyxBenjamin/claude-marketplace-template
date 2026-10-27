#!/usr/bin/env node
/**
 * @file Renders run_loop JSON output as an HTML report of description attempts per query; exports generateHtml, escapeHtml
 * @tags skill-creator, description-optimization, html-report
 * @related plugins/base-plugin/skills/skill-creator/scripts/run_loop.ts
 */
// Generate an HTML report from run_loop.ts output.
//
// Takes the JSON output from run_loop.ts and generates a visual HTML report
// showing each description attempt with check/x for each test case.
// Distinguishes between train and test queries.

import fs from 'node:fs';
import { z } from '../vendor/zod.generated.js';
import { parseArgv } from './cli.ts';
import { pyStr as str } from './py_json.ts';
import { check, LoopOutput } from './schemas.ts';
import type { HistoryAttempt, HistoryResult } from './schemas.ts';
import { isMain, parseChecked, runCli } from './utils.ts';

const PROG = 'generate_report.ts';

const HELP = `usage: ${PROG} [-h] [-o OUTPUT] [--skill-name SKILL_NAME] input

Generate HTML report from run_loop output

positional arguments:
  input                 Path to JSON output from run_loop.ts (or - for stdin)

options:
  -h, --help            show this help message and exit
  -o, --output OUTPUT   Output HTML file (default: stdout)
  --skill-name SKILL_NAME
                        Skill name to include in the report title
`;

/** Escape & < > " ' for HTML text and attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

type QueryInfo = { query: string; should_trigger: boolean };

const queryInfo = (r: HistoryResult): QueryInfo => ({ query: r.query, should_trigger: r.should_trigger ?? true });

function aggregateRuns(results: HistoryResult[]): [number, number] {
  let correct = 0;
  let total = 0;
  for (const r of results) {
    total += r.runs;
    correct += (r.should_trigger ?? true) ? r.triggers : r.runs - r.triggers;
  }
  return [correct, total];
}

function scoreClass(correct: number, total: number): string {
  if (total > 0) {
    const ratio = correct / total;
    if (ratio >= 0.8) return 'score-good';
    if (ratio >= 0.5) return 'score-ok';
  }
  return 'score-bad';
}

function resultCell(r: HistoryResult | undefined, extraClass: string): string {
  const didPass = r?.pass ?? false;
  const triggers = r?.triggers ?? 0;
  const runs = r?.runs ?? 0;
  const icon = didPass ? '✓' : '✗';
  const cssClass = didPass ? 'pass' : 'fail';
  return `                <td class="result ${extraClass}${cssClass}">${icon}<span class="rate">${triggers}/${runs}</span></td>\n`;
}

const trainResultsOf = (h: HistoryAttempt): HistoryResult[] => h.train_results ?? h.results ?? [];

/** Generate HTML report from loop output data (run_loop output). If autoRefresh is true, adds a meta refresh tag. */
export function generateHtml(data: LoopOutput, autoRefresh = false, skillName = ''): string {
  const history = data.history;
  const titlePrefix = skillName ? escapeHtml(skillName + ' — ') : '';

  // Unique queries from train and test sets, with should_trigger info
  const trainQueries: QueryInfo[] = [];
  const testQueries: QueryInfo[] = [];
  if (history.length) {
    for (const r of trainResultsOf(history[0])) trainQueries.push(queryInfo(r));
    for (const r of history[0].test_results ?? []) testQueries.push(queryInfo(r));
  }

  const refreshTag = autoRefresh ? '    <meta http-equiv="refresh" content="5">\n' : '';

  const parts = [`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
${refreshTag}    <title>${titlePrefix}Skill Description Optimization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Lora', Georgia, serif;
            max-width: 100%;
            margin: 0 auto;
            padding: 20px;
            background: #faf9f5;
            color: #141413;
        }
        h1 { font-family: 'Poppins', sans-serif; color: #141413; }
        .explainer {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
            color: #b0aea5;
            font-size: 0.875rem;
            line-height: 1.6;
        }
        .summary {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
        }
        .summary p { margin: 5px 0; }
        .best { color: #788c5d; font-weight: bold; }
        .table-container {
            overflow-x: auto;
            width: 100%;
        }
        table {
            border-collapse: collapse;
            background: white;
            border: 1px solid #e8e6dc;
            border-radius: 6px;
            font-size: 12px;
            min-width: 100%;
        }
        th, td {
            padding: 8px;
            text-align: left;
            border: 1px solid #e8e6dc;
            white-space: normal;
            word-wrap: break-word;
        }
        th {
            font-family: 'Poppins', sans-serif;
            background: #141413;
            color: #faf9f5;
            font-weight: 500;
        }
        th.test-col {
            background: #6a9bcc;
        }
        th.query-col { min-width: 200px; }
        td.description {
            font-family: monospace;
            font-size: 11px;
            word-wrap: break-word;
            max-width: 400px;
        }
        td.result {
            text-align: center;
            font-size: 16px;
            min-width: 40px;
        }
        td.test-result {
            background: #f0f6fc;
        }
        .pass { color: #788c5d; }
        .fail { color: #c44; }
        .rate {
            font-size: 9px;
            color: #b0aea5;
            display: block;
        }
        tr:hover { background: #faf9f5; }
        .score {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 11px;
        }
        .score-good { background: #eef2e8; color: #788c5d; }
        .score-ok { background: #fef3c7; color: #d97706; }
        .score-bad { background: #fceaea; color: #c44; }
        .train-label { color: #b0aea5; font-size: 10px; }
        .test-label { color: #6a9bcc; font-size: 10px; font-weight: bold; }
        .best-row { background: #f5f8f2; }
        th.positive-col { border-bottom: 3px solid #788c5d; }
        th.negative-col { border-bottom: 3px solid #c44; }
        th.test-col.positive-col { border-bottom: 3px solid #788c5d; }
        th.test-col.negative-col { border-bottom: 3px solid #c44; }
        .legend { font-family: 'Poppins', sans-serif; display: flex; gap: 20px; margin-bottom: 10px; font-size: 13px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-swatch { width: 16px; height: 16px; border-radius: 3px; display: inline-block; }
        .swatch-positive { background: #141413; border-bottom: 3px solid #788c5d; }
        .swatch-negative { background: #141413; border-bottom: 3px solid #c44; }
        .swatch-test { background: #6a9bcc; }
        .swatch-train { background: #141413; }
    </style>
</head>
<body>
    <h1>${titlePrefix}Skill Description Optimization</h1>
    <div class="explainer">
        <strong>Optimizing your skill's description.</strong> This page updates automatically as Claude tests different versions of your skill's description. Each row is an iteration — a new description attempt. The columns show test queries: green checkmarks mean the skill triggered correctly (or correctly didn't trigger), red crosses mean it got it wrong. The "Train" score shows performance on queries used to improve the description; the "Test" score shows performance on held-out queries the optimizer hasn't seen. When it's done, Claude will apply the best-performing description to your skill.
    </div>
`];

  // Summary section
  const bestTestScore = data.best_test_score ?? null;
  parts.push(`
    <div class="summary">
        <p><strong>Original:</strong> ${escapeHtml(data.original_description ?? 'N/A')}</p>
        <p class="best"><strong>Best:</strong> ${escapeHtml(data.best_description ?? 'N/A')}</p>
        <p><strong>Best Score:</strong> ${str(data.best_score ?? 'N/A')} ${bestTestScore ? '(test)' : '(train)'}</p>
        <p><strong>Iterations:</strong> ${str(data.iterations_run ?? 0)} | <strong>Train:</strong> ${str(data.train_size ?? '?')} | <strong>Test:</strong> ${str(data.test_size ?? '?')}</p>
    </div>
`);

  // Legend
  parts.push(`
    <div class="legend">
        <span style="font-weight:600">Query columns:</span>
        <span class="legend-item"><span class="legend-swatch swatch-positive"></span> Should trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-negative"></span> Should NOT trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-train"></span> Train</span>
        <span class="legend-item"><span class="legend-swatch swatch-test"></span> Test</span>
    </div>
`);

  // Table header
  parts.push(`
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Iter</th>
                <th>Train</th>
                <th>Test</th>
                <th class="query-col">Description</th>
`);

  for (const q of trainQueries) {
    const polarity = q.should_trigger ? 'positive-col' : 'negative-col';
    parts.push(`                <th class="${polarity}">${escapeHtml(q.query)}</th>\n`);
  }
  // Test query columns use a different color
  for (const q of testQueries) {
    const polarity = q.should_trigger ? 'positive-col' : 'negative-col';
    parts.push(`                <th class="test-col ${polarity}">${escapeHtml(q.query)}</th>\n`);
  }

  parts.push(`            </tr>
        </thead>
        <tbody>
`);

  // Best iteration for highlighting (first maximum wins)
  const bestKey = testQueries.length
    ? (h: HistoryAttempt) => h.test_passed || 0
    : (h: HistoryAttempt) => h.train_passed ?? h.passed ?? 0;
  if (!history.length) throw new Error('max() iterable argument is empty');
  let bestEntry = history[0];
  for (const h of history) if (bestKey(h) > bestKey(bestEntry)) bestEntry = h;
  const bestIter = bestEntry.iteration ?? null;

  for (const h of history) {
    const iteration = h.iteration ?? '?';
    const trainResults = trainResultsOf(h);
    const testResults = h.test_results ?? [];
    const description = h.description;

    const trainByQuery = new Map(trainResults.map((r) => [r.query, r]));
    const testByQuery = new Map(testResults.map((r) => [r.query, r]));

    const [trainCorrect, trainRuns] = aggregateRuns(trainResults);
    const [testCorrect, testRuns] = aggregateRuns(testResults);
    const trainClass = scoreClass(trainCorrect, trainRuns);
    const testClass = scoreClass(testCorrect, testRuns);
    const rowClass = iteration === bestIter ? 'best-row' : '';

    parts.push(`            <tr class="${rowClass}">
                <td>${str(iteration)}</td>
                <td><span class="score ${trainClass}">${trainCorrect}/${trainRuns}</span></td>
                <td><span class="score ${testClass}">${testCorrect}/${testRuns}</span></td>
                <td class="description">${escapeHtml(description)}</td>
`);
    for (const q of trainQueries) parts.push(resultCell(trainByQuery.get(q.query), ''));
    for (const q of testQueries) parts.push(resultCell(testByQuery.get(q.query), 'test-result '));
    parts.push('            </tr>\n');
  }

  parts.push(`        </tbody>
    </table>
    </div>
`);
  parts.push(`
</body>
</html>
`);

  return parts.join('');
}

const Args = z.object({
  output: z.string().nullable(),
  skill_name: z.string(),
  input: z.string(),
});

function main() {
  const args = check(
    Args,
    parseArgv(process.argv.slice(2), {
      prog: PROG,
      help: HELP,
      options: [{ flags: ['-o', '--output'] }, { flags: ['--skill-name'], default: '' }],
      positionals: [{ dest: 'input' }],
    }),
    'arguments',
  );
  const raw = fs.readFileSync(args.input === '-' ? 0 : args.input, 'utf8');
  const html = generateHtml(parseChecked(LoopOutput, raw, args.input === '-' ? 'stdin' : args.input), false, args.skill_name);

  if (args.output) {
    fs.writeFileSync(args.output, html);
    process.stderr.write(`Report written to ${args.output}\n`);
  } else {
    process.stdout.write(`${html}\n`);
  }
}

if (isMain(import.meta.url)) await runCli(main);
