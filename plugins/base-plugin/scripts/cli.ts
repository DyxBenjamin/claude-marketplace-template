/**
 * @file Parses argv and formats help argparse-style, with Python-style path helpers; exports parseArgv, formatHelp, pyPath
 * @tags skill-creator, cli
 */
// Minimal argparse-style command-line parsing: long-option abbreviations, --opt=value, -oVALUE, exit 2 on errors.

import { pyRepr } from './py_json.ts';

/** Python Path() string form: drops '.' components and repeated or trailing slashes. */
export function pyPath(p: string): string {
  const parts = p.split('/').filter((x) => x && x !== '.');
  const joined = parts.join('/');
  if (p.startsWith('/')) return '/' + joined;
  return joined || '.';
}

/** Python Path(a) / b as a string; '..' components are kept. */
export const pyJoin = (a: string, b: string): string => (a === '.' ? b : a.endsWith('/') ? a + b : `${a}/${b}`);

export type OptionType = 'str' | 'int' | 'float' | 'bool' | 'path';
export type CliOption = {
  flags: string[];
  type?: OptionType;
  default?: string | number | boolean | null;
  required?: boolean;
  help?: string;
};
export type CliPositional = { dest: string; type?: 'str' | 'path' };
export type CliSpec = { prog: string; help: string; options: CliOption[]; positionals?: CliPositional[] };

const WIDTH = 78;
const HELP_MAX = 24;
const longFlag = (o: CliOption): string => o.flags.find((f) => f.startsWith('--')) as string;
const destOf = (o: CliOption): string => longFlag(o).slice(2).replaceAll('-', '_');

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Help text in argparse layout for options that carry a single long flag. */
export function formatHelp(prog: string, description: string, options: CliOption[]): string {
  const inv = (o: CliOption) => (o.type === 'bool' ? longFlag(o) : `${longFlag(o)} ${destOf(o).toUpperCase()}`);
  const parts = ['[-h]', ...options.flatMap((o) => (o.required ? inv(o).split(' ') : [`[${inv(o)}]`]))];
  const prefix = 'usage: ';
  const all = [prog, ...parts];
  let usage: string;
  if (prefix.length + all.join(' ').length <= WIDTH) usage = `${prefix}${all.join(' ')}\n`;
  else {
    const indent = ' '.repeat(prefix.length + prog.length + 1);
    const lines: string[] = [];
    let line: string[] = [];
    let lineLen = prefix.length - 1;
    for (const part of all) {
      if (lineLen + 1 + part.length > WIDTH && line.length) {
        lines.push(indent + line.join(' '));
        line = [];
        lineLen = indent.length - 1;
      }
      line.push(part);
      lineLen += part.length + 1;
    }
    if (line.length) lines.push(indent + line.join(' '));
    lines[0] = lines[0].slice(indent.length);
    usage = `${prefix}${lines.join('\n')}\n`;
  }

  const rows = [['-h, --help', 'show this help message and exit'], ...options.map((o) => [inv(o), o.help ?? ''])];
  const maxLen = Math.max(...rows.map(([i]) => i.length + 2));
  const helpPos = Math.min(maxLen + 2, HELP_MAX);
  const actionWidth = helpPos - 4;
  const out: string[] = [];
  for (const [i, h] of rows) {
    const hl = wrapWords(h, Math.max(WIDTH - helpPos, 11));
    if (i.length <= actionWidth) out.push(`  ${i.padEnd(actionWidth)}  ${hl[0] ?? ''}`.trimEnd());
    else {
      out.push(`  ${i}`);
      if (hl.length) out.push(' '.repeat(helpPos) + hl[0]);
    }
    for (const l of hl.slice(1)) out.push(' '.repeat(helpPos) + l);
  }
  return `${usage}\n${description}\n\noptions:\n${out.join('\n')}\n`;
}

function fail(prog: string, help: string, message: string): never {
  const usage = help.slice(0, help.indexOf('\n\n') + 1);
  process.stderr.write(`${usage}${prog}: error: ${message}\n`);
  process.exit(2);
}

const INT_RE = /^\s*[+-]?\d+(_\d+)*\s*$/;
const FLOAT_RE = /^\s*[+-]?(\d+(_\d+)*\.?(\d+(_\d+)*)?|\.\d+(_\d+)*)([eE][+-]?\d+)?\s*$/;
const looksLikeFlag = (a: string): boolean => a.startsWith('-') && a !== '-' && !/^-\d+$|^-\d*\.\d+$/.test(a) && !a.includes(' ');

/**
 * Parse argv against a spec; the caller validates the returned values with a zod schema.
 * @returns values keyed by dest (long flag with '_' for '-'); unset options hold their default or null
 */
export function parseArgv(argv: string[], { prog, help, options, positionals = [] }: CliSpec): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const o of options) values[destOf(o)] = o.type === 'bool' ? false : (o.default ?? null);
  const longFlags: [string, CliOption][] = options.flatMap((o) => o.flags.filter((f) => f.startsWith('--')).map((f): [string, CliOption] => [f, o]));
  const names = (o: CliOption) => o.flags.join('/');
  const convert = (o: CliOption, raw: string): string | number => {
    if (o.type === 'int') {
      if (!INT_RE.test(raw)) fail(prog, help, `argument ${names(o)}: invalid int value: ${pyRepr(raw)}`);
      return parseInt(raw.replaceAll('_', ''), 10);
    }
    if (o.type === 'float') {
      if (!FLOAT_RE.test(raw)) fail(prog, help, `argument ${names(o)}: invalid float value: ${pyRepr(raw)}`);
      return parseFloat(raw.replaceAll('_', ''));
    }
    return o.type === 'path' ? pyPath(raw) : raw;
  };

  const seen = new Set<CliOption>();
  const pos: string[] = [];
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!looksLikeFlag(arg)) {
      pos.push(arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(help);
      process.exit(0);
    }
    let opt: CliOption | undefined;
    let inline: string | null = null;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      if (eq >= 0) inline = arg.slice(eq + 1);
      const exact = longFlags.find(([f]) => f === flag);
      const matches = exact ? [exact] : [...longFlags, ['--help', null] as [string, CliOption | null]].filter(([f]) => f.startsWith(flag));
      if (matches.length > 1) fail(prog, help, `ambiguous option: ${flag} could match ${matches.map(([f]) => f).join(', ')}`);
      if (matches.length === 1 && matches[0][1] === null) {
        process.stdout.write(help);
        process.exit(0);
      }
      opt = matches[0]?.[1] ?? undefined;
    } else {
      const flag = arg.slice(0, 2);
      opt = options.find((o) => o.flags.includes(flag));
      if (opt && arg.length > 2) inline = arg.slice(2).replace(/^=/, '');
    }
    if (!opt) {
      extra.push(arg);
      continue;
    }
    seen.add(opt);
    if (opt.type === 'bool') {
      if (inline !== null) fail(prog, help, `argument ${names(opt)}: ignored explicit argument ${pyRepr(inline)}`);
      values[destOf(opt)] = true;
      continue;
    }
    let raw = inline;
    if (raw === null) {
      if (i + 1 >= argv.length || looksLikeFlag(argv[i + 1])) fail(prog, help, `argument ${names(opt)}: expected one argument`);
      raw = argv[++i];
    }
    values[destOf(opt)] = convert(opt, raw);
  }

  const missing = [...options.filter((o) => o.required && !seen.has(o)).map(names), ...positionals.slice(pos.length).map((p) => p.dest)];
  if (missing.length) fail(prog, help, `the following arguments are required: ${missing.join(', ')}`);
  extra.push(...pos.slice(positionals.length));
  if (extra.length) fail(prog, help, `unrecognized arguments: ${extra.join(' ')}`);
  positionals.forEach((p, i) => {
    values[p.dest] = p.type === 'path' ? pyPath(pos[i]) : pos[i];
  });
  return values;
}
