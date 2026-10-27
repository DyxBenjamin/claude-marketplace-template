#!/usr/bin/env node
/**
 * @file Checks per query whether a skill description triggers the skill under `claude -p`; exports runEval, runSingleQuery
 * @tags skill-creator, evals, trigger
 * @related plugins/base-plugin/skills/fix-description/SKILL.md, plugins/base-plugin/skills/fix-description/queries.md
 */
// Run trigger evaluation for a skill description.
//
// Tests whether a skill's description causes Claude to trigger (read the skill)
// for a set of queries. Outputs results as JSON.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from '../vendor/zod.generated.js';
import { formatHelp, parseArgv } from './cli.ts';
import type { CliOption } from './cli.ts';
import { dumpJson, PyFloat, pyStr } from './py_json.ts';
import { check, RunEvalOutput, StreamEvent, TriggerEvalSet } from './schemas.ts';
import type { TriggerQuery, TriggerResult } from './schemas.ts';
import { childEnv, cut, isMain, loadJson, parseSkillMd, runCli } from './utils.ts';

/**
 * Finds the project root by walking up from cwd looking for .claude/.
 *
 * Mimics how Claude Code discovers its project root, so the command file
 * we create ends up where claude -p will look for it.
 */
export function findProjectRoot(): string {
  let current = process.cwd();
  for (;;) {
    try {
      if (fs.statSync(path.join(current, '.claude')).isDirectory()) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

type DetectState = { pendingToolName: string | null; accumulatedJson: string };

// Decides from one stream-json event; returns true/false when settled, undefined to keep reading.
function inspectEvent(event: StreamEvent, cleanName: string, state: DetectState): boolean | undefined {
  if (event.type === 'stream_event') {
    const se = event.event ?? {};
    const seType = se.type ?? '';

    if (seType === 'content_block_start') {
      const cb = se.content_block ?? {};
      if (cb.type === 'tool_use') {
        const toolName = cb.name ?? '';
        if (toolName === 'Skill' || toolName === 'Read') {
          state.pendingToolName = toolName;
          state.accumulatedJson = '';
        } else return false;
      }
    } else if (seType === 'content_block_delta' && state.pendingToolName) {
      const delta = se.delta ?? {};
      if (delta.type === 'input_json_delta') {
        state.accumulatedJson += delta.partial_json ?? '';
        if (state.accumulatedJson.includes(cleanName)) return true;
      }
    } else if (seType === 'content_block_stop' || seType === 'message_stop') {
      if (state.pendingToolName) return state.accumulatedJson.includes(cleanName);
      if (seType === 'message_stop') return false;
    }
  } else if (event.type === 'assistant') {
    const message = event.message ?? {};
    for (const item of message.content ?? []) {
      if (item.type !== 'tool_use') continue;
      const toolName = item.name ?? '';
      const input = item.input ?? {};
      if (toolName === 'Skill' && (input.skill ?? '').includes(cleanName)) return true;
      if (toolName === 'Read' && (input.file_path ?? '').includes(cleanName)) return true;
      return false;
    }
  } else if (event.type === 'result') return false;
  return undefined;
}

// Parses one stream-json line; lines that are not JSON or not a stream event are skipped.
function parseEvent(line: string): StreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = StreamEvent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Runs a single query and resolves to whether the skill was triggered.
 *
 * Creates a command file in .claude/commands/ so it appears in Claude's
 * available_skills list, then runs `claude -p` with the raw query.
 * Uses --include-partial-messages to detect triggering early from
 * stream events (content_block_start) rather than waiting for the
 * full assistant message, which only arrives after tool execution.
 */
export async function runSingleQuery(
  query: string,
  skillName: string,
  skillDescription: string,
  timeout: number,
  projectRoot: string,
  model: string | null = null,
): Promise<boolean> {
  const uniqueId = randomUUID().replace(/-/g, '').slice(0, 8);
  const cleanName = `${skillName}-skill-${uniqueId}`;
  const projectCommandsDir = path.join(projectRoot, '.claude', 'commands');
  const commandFile = path.join(projectCommandsDir, `${cleanName}.md`);

  try {
    fs.mkdirSync(projectCommandsDir, { recursive: true });
    // YAML block scalar avoids breaking on quotes in the description
    const indentedDesc = skillDescription.split('\n').join('\n  ');
    fs.writeFileSync(
      commandFile,
      `---\ndescription: |\n  ${indentedDesc}\n---\n\n# ${skillName}\n\nThis skill handles: ${skillDescription}\n`,
    );

    const cmd = ['-p', query, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (model) cmd.push('--model', model);

    const env = childEnv();

    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn('claude', cmd, { stdio: ['inherit', 'pipe', 'ignore'], cwd: projectRoot, env });
      const decoder = new StringDecoder('utf8');
      const state: DetectState = { pendingToolName: null, accumulatedJson: '' };
      let buffer = '';
      let settled = false;

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeout * 1000);

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => finish(false));
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = parseEvent(line);
          if (!event) continue;
          const result = inspectEvent(event, cleanName, state);
          if (result !== undefined) return finish(result);
        }
      });
    });
  } finally {
    fs.rmSync(commandFile, { force: true });
  }
}

export type RunEvalOptions = {
  evalSet: TriggerQuery[];
  skillName: string;
  description: string;
  numWorkers: number;
  timeout: number;
  projectRoot: string;
  runsPerQuery?: number;
  triggerThreshold?: number;
  model?: string | null;
};

/**
 * Runs the full eval set and resolves to the results object.
 * Runs up to numWorkers claude processes at a time.
 */
export async function runEval({
  evalSet,
  skillName,
  description,
  numWorkers,
  timeout,
  projectRoot,
  runsPerQuery = 1,
  triggerThreshold = 0.5,
  model = null,
}: RunEvalOptions): Promise<RunEvalOutput> {
  if (numWorkers <= 0) throw new Error('max_workers must be greater than 0');

  const tasks: TriggerQuery[] = [];
  for (const item of evalSet) {
    for (let run = 0; run < runsPerQuery; run++) tasks.push(item);
  }

  const queryTriggers = new Map<string, boolean[]>();
  const queryItems = new Map<string, TriggerQuery>();
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const item = tasks[next++];
      let outcome: boolean;
      try {
        outcome = await runSingleQuery(item.query, skillName, description, timeout, String(projectRoot), model);
      } catch (e) {
        console.error(`Warning: query failed: ${(e as Error).message}`);
        outcome = false;
      }
      queryItems.set(item.query, item);
      if (!queryTriggers.has(item.query)) queryTriggers.set(item.query, []);
      queryTriggers.get(item.query)?.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(numWorkers, tasks.length) }, worker));

  const results: TriggerResult[] = [];
  for (const [query, triggers] of queryTriggers) {
    const shouldTrigger = (queryItems.get(query) as TriggerQuery).should_trigger;
    const count = triggers.filter(Boolean).length;
    const triggerRate = count / triggers.length;
    const didPass = shouldTrigger ? triggerRate >= triggerThreshold : triggerRate < triggerThreshold;
    results.push({
      query,
      should_trigger: shouldTrigger,
      trigger_rate: new PyFloat(triggerRate),
      triggers: count,
      runs: triggers.length,
      pass: didPass,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  return check(
    RunEvalOutput,
    { skill_name: skillName, description, results, summary: { total, passed, failed: total - passed } },
    'run_eval results',
  );
}

const PROG = 'run_eval.ts';
const OPTIONS: CliOption[] = [
  { flags: ['--eval-set'], type: 'str', required: true, help: 'Path to eval set JSON file' },
  { flags: ['--skill-path'], type: 'str', required: true, help: 'Path to skill directory' },
  { flags: ['--description'], type: 'str', help: 'Override description to test' },
  { flags: ['--num-workers'], type: 'int', default: 10, help: 'Number of parallel workers' },
  { flags: ['--timeout'], type: 'int', default: 30, help: 'Timeout per query in seconds' },
  { flags: ['--runs-per-query'], type: 'int', default: 3, help: 'Number of runs per query' },
  { flags: ['--trigger-threshold'], type: 'float', default: 0.5, help: 'Trigger rate threshold' },
  { flags: ['--model'], type: 'str', help: "Model to use for claude -p (default: user's configured model)" },
  { flags: ['--verbose'], type: 'bool', help: 'Print progress to stderr' },
];

const Args = z.object({
  eval_set: z.string(),
  skill_path: z.string(),
  description: z.string().nullable(),
  num_workers: z.number().int().positive(),
  timeout: z.number().int(),
  runs_per_query: z.number().int(),
  trigger_threshold: z.number(),
  model: z.string().nullable(),
  verbose: z.boolean(),
});

async function main() {
  const help = formatHelp(PROG, 'Run trigger evaluation for a skill description', OPTIONS);
  const args = check(Args, parseArgv(process.argv.slice(2), { prog: PROG, help, options: OPTIONS }), 'arguments');

  const evalSet = loadJson(TriggerEvalSet, args.eval_set);
  const skillPath = args.skill_path;

  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const [name, originalDescription] = parseSkillMd(skillPath);
  const description = args.description || originalDescription;
  const projectRoot = findProjectRoot();

  if (args.verbose) console.error(`Evaluating: ${description}`);

  const output = await runEval({
    evalSet,
    skillName: name,
    description,
    numWorkers: args.num_workers,
    timeout: args.timeout,
    projectRoot,
    runsPerQuery: args.runs_per_query,
    triggerThreshold: args.trigger_threshold,
    model: args.model,
  });

  if (args.verbose) {
    const summary = output.summary;
    console.error(`Results: ${summary.passed}/${summary.total} passed`);
    for (const r of output.results) {
      const status = r.pass ? 'PASS' : 'FAIL';
      console.error(`  [${status}] rate=${r.triggers}/${r.runs} expected=${pyStr(r.should_trigger)}: ${cut(r.query, 70)}`);
    }
  }

  console.log(dumpJson(output, 2));
}

if (isMain(import.meta.url)) await runCli(main);
