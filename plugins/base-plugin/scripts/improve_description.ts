#!/usr/bin/env node
/**
 * @file Asks `claude -p` for a better skill description from trigger eval results and history; exports improveDescription
 * @tags skill-creator, description-optimization
 * @related plugins/base-plugin/scripts/run_eval.ts, plugins/base-plugin/skills/fix-description/SKILL.md
 */
// Improve a skill description based on eval results.
//
// Takes eval results (from run_eval.ts) and generates an improved description
// by calling `claude -p` as a subprocess (same auth pattern as run_eval.ts --
// uses the session's Claude Code auth, no separate ANTHROPIC_API_KEY needed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';
import { formatHelp, parseArgv } from './cli.ts';
import type { CliOption } from './cli.ts';
import { dumpJson, pyStr } from './py_json.ts';
import { check, ImproveHistory, ImproveInput, ImproveOutput, ImproveTranscript } from './schemas.ts';
import type { HistoryAttempt, TriggerResult } from './schemas.ts';
import { childEnv, cut, isMain, len, loadJson, parseSkillMd, runCli } from './utils.ts';

/**
 * Runs `claude -p` with the prompt on stdin and returns the text response.
 *
 * The prompt goes over stdin (not argv) because it embeds the full SKILL.md
 * body and can easily exceed comfortable argv length.
 */
function callClaude(prompt: string, model: string | null, timeout = 300): string {
  const cmd = ['-p', '--output-format', 'text'];
  if (model) cmd.push('--model', model);

  const result = spawnSync('claude', cmd, {
    input: prompt,
    encoding: 'utf8',
    env: childEnv(),
    timeout: timeout * 1000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new Error(`Command 'claude ${cmd.join(' ')}' timed out after ${timeout} seconds`);
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`claude -p exited ${result.status}\nstderr: ${result.stderr}`);
  }
  return result.stdout;
}

const stripQuotes = (s: string): string => s.trim().replace(/^"+|"+$/g, '');

function extractDescription(text: string): string {
  const match = /<new_description>([\s\S]*?)<\/new_description>/.exec(text);
  return stripQuotes(match ? match[1] : text);
}

type Scores = { results: TriggerResult[]; summary: { passed: number; failed: number; total: number } };

export type ImproveOptions = {
  skillName: string;
  skillContent: string;
  currentDescription: string;
  /** Train results */
  evalResults: Scores;
  /** Previous attempts */
  history: HistoryAttempt[];
  model: string;
  testResults?: Scores | null;
  logDir?: string | null;
  iteration?: number | null;
};

/** Calls Claude to improve the description based on eval results; returns the new description. */
export function improveDescription({
  skillName,
  skillContent,
  currentDescription,
  evalResults,
  history,
  model,
  testResults = null,
  logDir = null,
  iteration = null,
}: ImproveOptions): string {
  const failedTriggers = evalResults.results.filter((r) => r.should_trigger && !r.pass);
  const falseTriggers = evalResults.results.filter((r) => !r.should_trigger && !r.pass);

  // Build scores summary
  const trainScore = `${evalResults.summary.passed}/${evalResults.summary.total}`;
  let scoresSummary: string;
  if (testResults) {
    const testScore = `${testResults.summary.passed}/${testResults.summary.total}`;
    scoresSummary = `Train: ${trainScore}, Test: ${testScore}`;
  } else {
    scoresSummary = `Train: ${trainScore}`;
  }

  let prompt = `You are optimizing a skill description for a Claude Code skill called "${skillName}". A "skill" is sort of like a prompt, but with progressive disclosure -- there's a title and description that Claude sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder like helper files and scripts and additional documentation or examples.

The description appears in Claude's "available_skills" list. When a user sends a query, Claude decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.

Here's the current description:
<current_description>
"${currentDescription}"
</current_description>

Current scores (${scoresSummary}):
<scores_summary>
`;
  if (failedTriggers.length) {
    prompt += 'FAILED TO TRIGGER (should have triggered but didn\'t):\n';
    for (const r of failedTriggers) prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    prompt += '\n';
  }

  if (falseTriggers.length) {
    prompt += 'FALSE TRIGGERS (triggered but shouldn\'t have):\n';
    for (const r of falseTriggers) prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    prompt += '\n';
  }

  if (history.length) {
    prompt += 'PREVIOUS ATTEMPTS (do NOT repeat these — try something structurally different):\n\n';
    for (const h of history) {
      const trainS = `${pyStr('train_passed' in h ? h.train_passed : (h.passed ?? 0))}/${pyStr('train_total' in h ? h.train_total : (h.total ?? 0))}`;
      const testS = h.test_passed != null ? `${pyStr('test_passed' in h ? h.test_passed : '?')}/${pyStr('test_total' in h ? h.test_total : '?')}` : null;
      const scoreStr = `train=${trainS}${testS ? `, test=${testS}` : ''}`;
      prompt += `<attempt ${scoreStr}>\n`;
      prompt += `Description: "${h.description}"\n`;
      if (h.results) {
        prompt += 'Train results:\n';
        for (const r of h.results) {
          const status = r.pass ? 'PASS' : 'FAIL';
          prompt += `  [${status}] "${cut(r.query, 80)}" (triggered ${r.triggers}/${r.runs})\n`;
        }
      }
      if (h.note) prompt += `Note: ${h.note}\n`;
      prompt += '</attempt>\n\n';
    }
  }

  prompt += `</scores_summary>

Skill content (for context on what the skill does):
<skill_content>
${skillContent}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. When I say "based on the failures", it's a bit of a tricky line to walk because we don't want to overfit to the specific cases you're seeing. So what I DON'T want you to do is produce an ever-expanding list of specific queries that this skill should or shouldn't trigger for. Instead, try to generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful. The reason for this is twofold:

1. Avoid overfitting
2. The list might get loooong and it's injected into ALL queries and there might be a lot of skills, so we don't want to blow too much space on any given description.

Concretely, your description should not be more than about 100-200 words, even if that comes at the cost of accuracy. There is a hard limit of 1024 characters — descriptions over that will be truncated, so stay comfortably under it.

Here are some tips that we've found to work well in writing these descriptions:
- The skill should be phrased in the imperative -- "Use this skill for" rather than "this skill does"
- The skill description should focus on the user's intent, what they are trying to achieve, vs. the implementation details of how the skill works.
- The description competes with other skills for Claude's attention — make it distinctive and immediately recognizable.
- If you're getting lots of failures after repeated attempts, change things up. Try different sentence structures or wordings.

I'd encourage you to be creative and mix up the style in different iterations since you'll have multiple opportunities to try different approaches and we'll just grab the highest-scoring one at the end. 

Please respond with only the new description text in <new_description> tags, nothing else.`;

  const text = callClaude(prompt, model);
  let description = extractDescription(text);

  const transcript: Record<string, unknown> = {
    iteration,
    prompt,
    response: text,
    parsed_description: description,
    char_count: len(description),
    over_limit: len(description) > 1024,
  };

  // Safety net: if the model exceeded the 1024-char hard limit, make one fresh
  // single-turn call that quotes the too-long version and asks for a rewrite.
  if (len(description) > 1024) {
    const shortenPrompt =
      `${prompt}\n\n` +
      '---\n\n' +
      `A previous attempt produced this description, which at ${len(description)} characters is over the 1024-character hard limit:\n\n` +
      `"${description}"\n\n` +
      'Rewrite it to be under 1024 characters while keeping the most important trigger words and intent coverage. ' +
      'Respond with only the new description in <new_description> tags.';
    const shortenText = callClaude(shortenPrompt, model);
    const shortened = extractDescription(shortenText);

    transcript.rewrite_prompt = shortenPrompt;
    transcript.rewrite_response = shortenText;
    transcript.rewrite_description = shortened;
    transcript.rewrite_char_count = len(shortened);
    description = shortened;
  }

  transcript.final_description = description;

  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    const logged = check(ImproveTranscript, transcript, 'improve_description transcript');
    fs.writeFileSync(path.join(logDir, `improve_iter_${iteration || 'unknown'}.json`), dumpJson(logged, 2));
  }

  return description;
}

const PROG = 'improve_description.ts';
const OPTIONS: CliOption[] = [
  { flags: ['--eval-results'], type: 'str', required: true, help: 'Path to eval results JSON (from run_eval.ts)' },
  { flags: ['--skill-path'], type: 'str', required: true, help: 'Path to skill directory' },
  { flags: ['--history'], type: 'str', help: 'Path to history JSON (previous attempts)' },
  { flags: ['--model'], type: 'str', required: true, help: 'Model for improvement' },
  { flags: ['--verbose'], type: 'bool', help: 'Print thinking to stderr' },
];

const Args = z.object({
  eval_results: z.string(),
  skill_path: z.string(),
  history: z.string().nullable(),
  model: z.string(),
  verbose: z.boolean(),
});

function main() {
  const help = formatHelp(PROG, 'Improve a skill description based on eval results', OPTIONS);
  const args = check(Args, parseArgv(process.argv.slice(2), { prog: PROG, help, options: OPTIONS }), 'arguments');

  const skillPath = args.skill_path;
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const evalResults = loadJson(ImproveInput, args.eval_results);
  const history = args.history ? loadJson(ImproveHistory, args.history) : [];

  const [name, , content] = parseSkillMd(skillPath);
  const currentDescription = evalResults.description;

  if (args.verbose) {
    console.error(`Current: ${currentDescription}`);
    console.error(`Score: ${evalResults.summary.passed}/${evalResults.summary.total}`);
  }

  const newDescription = improveDescription({
    skillName: name,
    skillContent: content,
    currentDescription,
    evalResults,
    history,
    model: args.model,
  });

  if (args.verbose) console.error(`Improved: ${newDescription}`);

  // Output as JSON with both the new description and updated history
  const output = check(
    ImproveOutput,
    {
      description: newDescription,
      history: [
        ...history,
        {
          description: currentDescription,
          passed: evalResults.summary.passed,
          failed: evalResults.summary.failed,
          total: evalResults.summary.total,
          results: evalResults.results,
        },
      ],
    },
    'improve_description output',
  );
  console.log(dumpJson(output, 2));
}

if (isMain(import.meta.url)) await runCli(main);
