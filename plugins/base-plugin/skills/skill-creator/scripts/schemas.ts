/**
 * @file Defines zod schemas for skill-creator and eval-viewer JSON files; exports check, SchemaError and pyNum.
 * @tags skill-creator, zod, json, evals
 * @related plugins/base-plugin/skills/skill-creator/references/schemas.md, plugins/base-plugin/skills/skill-creator/scripts/py_json.ts
 */
// Shared zod schemas for every JSON the skill-creator scripts and the eval viewer read or write. The documented
// files mirror references/schemas.md. Objects are loose: unknown fields pass through. Fields a reader defaults when
// absent (older files) are optional. Numbers are pyNum so an int and a float stay distinguishable.
import { z } from '../vendor/zod.generated.js';
import { PyFloat } from './py_json.ts';
import type { PyNum } from './py_json.ts';

export class SchemaError extends Error {}

/** One-line text for the issues of a failed parse: `path: message; path: message`. */
export function describeIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ');
}

/**
 * Validates value against schema and returns it unchanged, so key order and int/float types survive a rewrite.
 * @throws {SchemaError} naming label and every failing path
 */
export function check<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SchemaError(`Invalid ${label}: ${describeIssues(result.error)}`);
  return value as z.output<S>;
}

export const pyNum = z.custom<PyNum>((v) => typeof v === 'number' || v instanceof PyFloat, 'Invalid input: expected number');
const strings = z.array(z.string());
const id = z.union([pyNum, z.string()]);
const obj = z.looseObject;

// evals.json
export const EvalCase = obj({
  id: pyNum,
  prompt: z.string(),
  expected_output: z.string(),
  files: strings.optional(),
  expectations: strings,
});
export const EvalsFile = obj({ skill_name: z.string(), evals: z.array(EvalCase) });

// history.json
export const HistoryIteration = obj({
  version: z.string(),
  parent: z.string().nullable(),
  expectation_pass_rate: pyNum,
  grading_result: z.enum(['baseline', 'won', 'lost', 'tie']),
  is_current_best: z.boolean(),
});
export const HistoryFile = obj({
  started_at: z.string(),
  skill_name: z.string(),
  current_best: z.string(),
  iterations: z.array(HistoryIteration),
});

// grading.json: every section is optional because readers default an absent one.
export const Expectation = obj({ text: z.string(), passed: z.boolean(), evidence: z.string() });
export const GradingExpectation = Expectation.partial();
export const GradingSummary = obj({ passed: pyNum, failed: pyNum, total: pyNum, pass_rate: pyNum }).partial();
export const ExecutionMetrics = obj({
  tool_calls: z.record(z.string(), pyNum),
  total_tool_calls: pyNum,
  total_steps: pyNum,
  errors_encountered: pyNum,
  output_chars: pyNum,
  transcript_chars: pyNum,
}).partial();
export const GradingTiming = obj({
  executor_duration_seconds: pyNum,
  grader_duration_seconds: pyNum,
  total_duration_seconds: pyNum,
}).partial();
export const Grading = obj({
  expectations: z.array(GradingExpectation).optional(),
  summary: GradingSummary.optional(),
  execution_metrics: ExecutionMetrics.optional(),
  timing: GradingTiming.optional(),
  claims: z.array(obj({ claim: z.string(), type: z.string(), verified: z.boolean(), evidence: z.string() }).partial()).optional(),
  user_notes_summary: obj({ uncertainties: strings, needs_review: strings, workarounds: strings }).partial().optional(),
  eval_feedback: obj({
    suggestions: z.array(obj({ assertion: z.string(), reason: z.string() }).partial()).optional(),
    overall: z.string().optional(),
  }).optional(),
});

// metrics.json
export const Metrics = obj({
  tool_calls: z.record(z.string(), pyNum),
  total_tool_calls: pyNum,
  total_steps: pyNum,
  files_created: strings,
  errors_encountered: pyNum,
  output_chars: pyNum,
  transcript_chars: pyNum,
});

// timing.json
export const Timing = obj({
  total_tokens: pyNum,
  duration_ms: pyNum,
  total_duration_seconds: pyNum,
  executor_start: z.string(),
  executor_end: z.string(),
  executor_duration_seconds: pyNum,
  grader_start: z.string(),
  grader_end: z.string(),
  grader_duration_seconds: pyNum,
}).partial();

// benchmark.json
export const Stat = obj({ mean: pyNum, stddev: pyNum, min: pyNum, max: pyNum });
export const ConfigSummary = obj({ pass_rate: Stat, time_seconds: Stat, tokens: Stat });
export const Delta = obj({ pass_rate: z.string(), time_seconds: z.string(), tokens: z.string() });
export const BenchmarkRun = obj({
  eval_id: id,
  eval_name: z.string().optional(),
  configuration: z.string(),
  run_number: pyNum,
  result: obj({
    pass_rate: pyNum,
    passed: pyNum,
    failed: pyNum.optional(),
    total: pyNum,
    time_seconds: pyNum,
    tokens: pyNum,
    tool_calls: pyNum.optional(),
    errors: pyNum,
  }),
  expectations: z.array(GradingExpectation),
  notes: strings,
});
export const Benchmark = obj({
  metadata: obj({
    skill_name: z.string(),
    skill_path: z.string().optional(),
    executor_model: z.string().optional(),
    analyzer_model: z.string().optional(),
    timestamp: z.string(),
    evals_run: z.array(id),
    runs_per_configuration: pyNum,
  }),
  runs: z.array(BenchmarkRun),
  run_summary: obj({ delta: Delta.optional() }).catchall(ConfigSummary),
  notes: strings,
});

// comparison.json
const Rubric = obj({
  content: z.record(z.string(), pyNum),
  structure: z.record(z.string(), pyNum),
  content_score: pyNum,
  structure_score: pyNum,
  overall_score: pyNum,
});
const ExpectationResults = obj({
  passed: pyNum,
  total: pyNum,
  pass_rate: pyNum,
  details: z.array(obj({ text: z.string(), passed: z.boolean() })),
});
const Quality = obj({ score: pyNum, strengths: strings, weaknesses: strings });
export const Comparison = obj({
  winner: z.string(),
  reasoning: z.string(),
  rubric: obj({ A: Rubric, B: Rubric }),
  output_quality: obj({ A: Quality, B: Quality }),
  expectation_results: obj({ A: ExpectationResults, B: ExpectationResults }),
});

// analysis.json
const Adherence = obj({ score: pyNum, issues: strings });
export const Analysis = obj({
  comparison_summary: obj({
    winner: z.string(),
    winner_skill: z.string(),
    loser_skill: z.string(),
    comparator_reasoning: z.string(),
  }),
  winner_strengths: strings,
  loser_weaknesses: strings,
  instruction_following: obj({ winner: Adherence, loser: Adherence }),
  improvement_suggestions: z.array(
    obj({ priority: z.string(), category: z.string(), suggestion: z.string(), expected_impact: z.string() }),
  ),
  transcript_insights: obj({ winner_execution_pattern: z.string(), loser_execution_pattern: z.string() }),
});

// eval_metadata.json (one per eval directory)
export const EvalMetadata = obj({
  eval_id: id.nullable().optional(),
  eval_name: z.string().optional(),
  prompt: z.string().optional(),
  assertions: z.array(z.unknown()).optional(),
});

// feedback.json (written by the viewer)
export const Review = obj({ run_id: z.string(), feedback: z.string(), timestamp: z.string().optional() });
export const FeedbackFile = obj({ reviews: z.array(Review), status: z.string().optional() });

// Trigger eval set and results (run_eval, improve_description, run_loop, generate_report)
export const TriggerQuery = obj({ query: z.string(), should_trigger: z.boolean() });
export const TriggerEvalSet = z.array(TriggerQuery);
export const TriggerResult = obj({
  query: z.string(),
  should_trigger: z.boolean(),
  trigger_rate: pyNum,
  triggers: z.number(),
  runs: z.number(),
  pass: z.boolean(),
});
export const TriggerSummary = obj({ total: z.number(), passed: z.number(), failed: z.number() });
export const RunEvalOutput = obj({
  skill_name: z.string(),
  description: z.string(),
  results: z.array(TriggerResult),
  summary: TriggerSummary,
});
// Results kept in a loop history: older files omit should_trigger (true) and trigger_rate.
export const HistoryResult = TriggerResult.partial({ should_trigger: true, trigger_rate: true });
export const HistoryAttempt = obj({
  iteration: z.number().optional(),
  description: z.string(),
  passed: z.number().optional(),
  failed: z.number().optional(),
  total: z.number().optional(),
  train_passed: z.number().optional(),
  train_failed: z.number().optional(),
  train_total: z.number().optional(),
  train_results: z.array(HistoryResult).optional(),
  test_passed: z.number().nullable().optional(),
  test_failed: z.number().nullable().optional(),
  test_total: z.number().nullable().optional(),
  test_results: z.array(HistoryResult).nullable().optional(),
  results: z.array(HistoryResult).optional(),
  note: z.string().optional(),
});
export const ImproveHistory = z.array(HistoryAttempt);
export const ImproveInput = obj({
  description: z.string(),
  summary: TriggerSummary,
  results: z.array(TriggerResult),
});
export const ImproveOutput = obj({ description: z.string(), history: ImproveHistory });
export const ImproveTranscript = obj({
  iteration: z.number().nullable(),
  prompt: z.string(),
  response: z.string(),
  parsed_description: z.string(),
  char_count: z.number(),
  over_limit: z.boolean(),
  rewrite_prompt: z.string().optional(),
  rewrite_response: z.string().optional(),
  rewrite_description: z.string().optional(),
  rewrite_char_count: z.number().optional(),
  final_description: z.string(),
});
export const LoopOutput = obj({
  exit_reason: z.string().optional(),
  original_description: z.string().optional(),
  best_description: z.string().optional(),
  best_score: z.string().optional(),
  best_train_score: z.string().optional(),
  best_test_score: z.string().nullable().optional(),
  final_description: z.string().optional(),
  iterations_run: z.number().optional(),
  holdout: pyNum.optional(),
  train_size: z.number().optional(),
  test_size: z.number().optional(),
  history: z.array(HistoryAttempt),
});

// One `claude -p --output-format stream-json` line; fields the detector ignores are not listed.
export const StreamEvent = obj({
  type: z.string().nullish(),
  event: obj({
    type: z.string().nullish(),
    content_block: obj({ type: z.string().nullish(), name: z.string().nullish() }).nullish(),
    delta: obj({ type: z.string().nullish(), partial_json: z.string().nullish() }).nullish(),
  }).nullish(),
  message: obj({
    content: z
      .array(
        obj({
          type: z.string().nullish(),
          name: z.string().nullish(),
          input: obj({ skill: z.string().nullish(), file_path: z.string().nullish() }).nullish(),
        }),
      )
      .nullish(),
  }).nullish(),
});

// Eval viewer page data
const OutputName = { name: z.string() };
export const OutputFile = z.discriminatedUnion('type', [
  obj({ ...OutputName, type: z.literal('text'), content: z.string() }),
  obj({ ...OutputName, type: z.literal('error'), content: z.string() }),
  obj({ ...OutputName, type: z.literal('image'), mime: z.string(), data_uri: z.string() }),
  obj({ ...OutputName, type: z.literal('pdf'), data_uri: z.string() }),
  obj({ ...OutputName, type: z.literal('xlsx'), data_b64: z.string() }),
  obj({ ...OutputName, type: z.literal('binary'), mime: z.string(), data_uri: z.string() }),
]);
export const ViewerRun = obj({
  id: z.string(),
  prompt: z.string(),
  eval_id: id.nullable(),
  outputs: z.array(OutputFile),
  grading: Grading.nullable(),
});
export const EmbeddedData = obj({
  skill_name: z.string(),
  runs: z.array(ViewerRun),
  previous_feedback: z.map(z.string(), z.string()),
  previous_outputs: z.map(z.string(), z.array(OutputFile)),
  benchmark: Benchmark.optional(),
});

export type Grading = z.infer<typeof Grading>;
export type Benchmark = z.infer<typeof Benchmark>;
export type BenchmarkRun = z.infer<typeof BenchmarkRun>;
export type ConfigSummary = z.infer<typeof ConfigSummary>;
export type Stat = z.infer<typeof Stat>;
export type OutputFile = z.infer<typeof OutputFile>;
export type ViewerRun = z.infer<typeof ViewerRun>;
export type TriggerQuery = z.infer<typeof TriggerQuery>;
export type TriggerResult = z.infer<typeof TriggerResult>;
export type HistoryResult = z.infer<typeof HistoryResult>;
export type RunEvalOutput = z.infer<typeof RunEvalOutput>;
export type HistoryAttempt = z.infer<typeof HistoryAttempt>;
export type ImproveTranscript = z.infer<typeof ImproveTranscript>;
export type LoopOutput = z.infer<typeof LoopOutput>;
export type StreamEvent = z.infer<typeof StreamEvent>;
export type GradingExpectation = z.infer<typeof GradingExpectation>;

// Name and description pulled from SKILL.md frontmatter by parseSkillMd
export const SkillMeta = obj({ name: z.string(), description: z.string() });

// Environment handed to `claude -p`
export const Env = z.record(z.string(), z.string().optional());
