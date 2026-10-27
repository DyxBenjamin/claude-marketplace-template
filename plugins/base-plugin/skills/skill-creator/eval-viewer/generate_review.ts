#!/usr/bin/env node
/**
 * @file CLI that builds the eval review page from a workspace and serves it over HTTP or writes it as static HTML
 * @tags skill-creator, eval-viewer, cli
 * @related plugins/base-plugin/skills/skill-creator/eval-viewer/review_data.ts, plugins/base-plugin/skills/skill-creator/eval-viewer/review_server.ts
 */
// Generate and serve a review page for eval results.
//
// Reads the workspace directory, discovers runs (directories with outputs/),
// embeds all output data into a self-contained HTML page, and serves it via
// a tiny HTTP server. Feedback auto-saves to feedback.json in the workspace.
//
// Usage:
//     node generate_review.ts <workspace-path> [--port PORT] [--skill-name NAME]
//     node generate_review.ts <workspace-path> --previous-workspace /path/to/old/workspace
//
// No dependencies beyond Node built-ins are required.

import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';
import { parseArgv, pyJoin } from '../scripts/cli.ts';
import { check } from '../scripts/schemas.ts';
import { isDir, isMain, runCli } from '../scripts/utils.ts';
import { findRuns, generateHtml, loadBenchmark, loadPreviousIteration } from './review_data.ts';
import type { Previous } from './review_data.ts';
import { createServer, killPort, listen, openBrowser } from './review_server.ts';

export { findRuns, generateHtml, loadPreviousIteration };

const PROG = 'generate_review.ts';

const HELP = `usage: ${PROG} [-h] [--port PORT] [--skill-name SKILL_NAME]
                          [--previous-workspace PREVIOUS_WORKSPACE]
                          [--benchmark BENCHMARK] [--static STATIC]
                          workspace

Generate and serve eval review

positional arguments:
  workspace             Path to workspace directory

options:
  -h, --help            show this help message and exit
  --port, -p PORT       Server port (default: 3117)
  --skill-name, -n SKILL_NAME
                        Skill name for header
  --previous-workspace PREVIOUS_WORKSPACE
                        Path to previous iteration's workspace (shows old
                        outputs and feedback as context)
  --benchmark BENCHMARK
                        Path to benchmark.json to show in the Benchmark tab
  --static, -s STATIC   Write standalone HTML to this path instead of starting
                        a server
`;

const say = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const Args = z.object({
  port: z.number().int().min(0).max(65535),
  skill_name: z.string().nullable(),
  previous_workspace: z.string().nullable(),
  benchmark: z.string().nullable(),
  static: z.string().nullable(),
  workspace: z.string(),
});

async function main() {
  const args = check(
    Args,
    parseArgv(process.argv.slice(2), {
      prog: PROG,
      help: HELP,
      options: [
        { flags: ['--port', '-p'], type: 'int', default: 3117 },
        { flags: ['--skill-name', '-n'] },
        { flags: ['--previous-workspace'], type: 'path' },
        { flags: ['--benchmark'], type: 'path' },
        { flags: ['--static', '-s'], type: 'path' },
      ],
      positionals: [{ dest: 'workspace', type: 'path' }],
    }),
    'arguments',
  );

  const workspace = realpath(args.workspace);
  if (!isDir(workspace)) {
    process.stderr.write(`Error: ${workspace} is not a directory\n`);
    process.exit(1);
  }

  const runs = findRuns(workspace);
  if (!runs.length) {
    process.stderr.write(`No runs found in ${workspace}\n`);
    process.exit(1);
  }

  const skillName = args.skill_name || path.basename(workspace).replaceAll('-workspace', '');
  const feedbackPath = pyJoin(workspace, 'feedback.json');

  let previous: Previous = new Map();
  if (args.previous_workspace !== null) previous = loadPreviousIteration(realpath(args.previous_workspace));

  const benchmarkPath = args.benchmark !== null ? realpath(args.benchmark) : null;
  const benchmark = loadBenchmark(benchmarkPath);

  if (args.static !== null) {
    const html = generateHtml(runs, skillName, previous, benchmark);
    fs.mkdirSync(path.dirname(args.static), { recursive: true });
    fs.writeFileSync(args.static, html);
    say(`\n  Static viewer written to: ${args.static}\n`);
    process.exit(0);
  }

  // Kill any existing process on the target port
  let port = args.port;
  killPort(port);
  const server = createServer({ workspace, skillName, feedbackPath, previous, benchmarkPath });
  try {
    port = await listen(server, port);
  } catch {
    // Port still in use after kill attempt: find a free one
    port = await listen(server, 0);
  }

  const url = `http://localhost:${port}`;
  say('\n  Eval Viewer');
  say('  ─────────────────────────────────');
  say(`  URL:       ${url}`);
  say(`  Workspace: ${workspace}`);
  say(`  Feedback:  ${feedbackPath}`);
  if (previous.size) say(`  Previous:  ${args.previous_workspace} (${previous.size} runs)`);
  if (benchmarkPath) say(`  Benchmark: ${benchmarkPath}`);
  say('\n  Press Ctrl+C to stop.\n');

  openBrowser(url);

  process.on('SIGINT', () => {
    say('\nStopped.');
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}

if (isMain(import.meta.url)) await runCli(main);
