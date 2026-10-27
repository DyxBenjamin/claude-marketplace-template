/**
 * @file Shared script helpers: SKILL.md parsing, text and JSON file reads, code-point text helpers, CLI entry wrapper
 * @tags skill-creator, cli
 */
// Shared utilities for the skill-authoring scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSONDecodeError, parseJson } from './py_json.ts';
import { check, Env, SchemaError, SkillMeta } from './schemas.ts';
import type { z } from '../vendor/zod.generated.js';

/** Reads a text file with universal newlines. */
export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

/** Reads a file as bytes. */
export const readBytes = (file: string): Buffer => fs.readFileSync(file);

export const isDir = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
export const isFile = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** Reads a JSON file and validates it; a JSONDecodeError from the text propagates. */
export function readJson<S extends z.ZodType>(schema: S, file: string, label = file): z.output<S> {
  return check(schema, parseJson(readText(file)), label);
}

/** Parses JSON text and validates it; a JSON syntax error surfaces as a SchemaError naming the source. */
export function parseChecked<S extends z.ZodType>(schema: S, text: string, source: string): z.output<S> {
  try {
    return check(schema, parseJson(text), source);
  } catch (e) {
    if (e instanceof JSONDecodeError) throw new SchemaError(`Invalid ${source}: ${e.message}`);
    throw e;
  }
}

/** Reads and validates a required CLI input file. */
export function loadJson<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseChecked(schema, readText(file), file);
}

/** Parses a SKILL.md file, returning [name, description, fullContent]. */
export function parseSkillMd(skillPath: string): [string, string, string] {
  const content = readText(path.join(skillPath, 'SKILL.md'));
  const lines = content.split('\n');

  if (lines[0].trim() !== '---') {
    throw new Error('SKILL.md missing frontmatter (no opening ---)');
  }

  let endIdx: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === null) {
    throw new Error('SKILL.md missing frontmatter (no closing ---)');
  }

  let name = '';
  let description = '';
  const front = lines.slice(1, endIdx);
  const unquote = (s: string) => s.trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  let i = 0;
  while (i < front.length) {
    const line = front[i];
    if (line.startsWith('name:')) {
      name = unquote(line.slice('name:'.length));
    } else if (line.startsWith('description:')) {
      const value = line.slice('description:'.length).trim();
      // Multiline indicators: >, |, >-, |-
      if (['>', '|', '>-', '|-'].includes(value)) {
        const continuation: string[] = [];
        i++;
        while (i < front.length && (front[i].startsWith('  ') || front[i].startsWith('\t'))) {
          continuation.push(front[i].trim());
          i++;
        }
        description = continuation.join(' ');
        continue;
      }
      description = value.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    }
    i++;
  }

  const meta = check(SkillMeta, { name, description }, 'SKILL.md frontmatter');
  return [meta.name, meta.description, content];
}

/** Length in code points. */
export const len = (s: string): number => [...s].length;

/** First n code points of a string. */
export const cut = (s: string, n: number): string => [...s].slice(0, n).join('');

/** Formats a ratio as an integer percentage, ties rounding to even. */
export function pct(x: number): string {
  const v = x * 100;
  const f = Math.floor(v);
  const r = v - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  return `${r}%`;
}

/** The process environment for a nested `claude -p`: CLAUDECODE is removed so it can run inside a Claude Code session. */
export function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  check(Env, env, 'environment');
  delete env.CLAUDECODE;
  return env;
}

/** True when the module at metaUrl is the process entry point. */
export function isMain(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Runs a CLI main; a rejected input (SchemaError) prints `Error: message` to stderr and exits 1. */
export async function runCli(main: () => void | Promise<void>): Promise<void> {
  try {
    await main();
  } catch (e) {
    if (!(e instanceof SchemaError)) throw e;
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}
