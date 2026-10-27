#!/usr/bin/env node
/**
 * @file Validates a skill's SKILL.md frontmatter keys, name and description; exports validateSkill and runs as a CLI
 * @tags skill-creator, validation
 * @related plugins/base-plugin/skills/skill-creator/scripts/mini_yaml.ts
 */
// Quick validation script for skills - minimal version
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../vendor/zod.generated.js';
import { Parser, truthy, typeName, YamlError } from './mini_yaml.ts';
import { isMain, len, readText } from './utils.ts';

const ALLOWED_PROPERTIES = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);

const present = (key: string) => z.custom<unknown>((v) => v !== undefined, `Missing '${key}' in frontmatter`);
const text = (label: string) => z.string({ error: (iss) => `${label} must be a string, got ${typeName(iss.input)}` });

// Stages run in order and the first issue is the message: keys, presence, then field values.
const Keys = z.array(z.unknown()).superRefine((keys, ctx) => {
  const unexpected = keys.filter((k) => !ALLOWED_PROPERTIES.has(k as string));
  if (!unexpected.length) return;
  const allowed = [...ALLOWED_PROPERTIES].sort().join(', ');
  ctx.addIssue({
    code: 'custom',
    message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.sort().join(', ')}. Allowed properties are: ${allowed}`,
  });
});

const Presence = z.looseObject({ name: present('name'), description: present('description') });

const Fields = z.looseObject({
  name: text('Name').superRefine((raw, ctx) => {
    const name = raw.trim();
    if (!name) return;
    const message = !/^[a-z0-9-]+$/.test(name)
      ? `Name '${name}' should be kebab-case (lowercase letters, digits, and hyphens only)`
      : name.startsWith('-') || name.endsWith('-') || name.includes('--')
        ? `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`
        : len(name) > 64
          ? `Name is too long (${len(name)} characters). Maximum is 64 characters.`
          : null;
    if (message) ctx.addIssue({ code: 'custom', message });
  }),
  description: text('Description').superRefine((raw, ctx) => {
    const description = raw.trim();
    if (!description) return;
    const message =
      description.includes('<') || description.includes('>')
        ? 'Description cannot contain angle brackets (< or >)'
        : len(description) > 1024
          ? `Description is too long (${len(description)} characters). Maximum is 1024 characters.`
          : null;
    if (message) ctx.addIssue({ code: 'custom', message });
  }),
  compatibility: z
    .unknown()
    .superRefine((value, ctx) => {
      if (!truthy(value)) return;
      if (typeof value !== 'string') ctx.addIssue({ code: 'custom', message: `Compatibility must be a string, got ${typeName(value)}` });
      else if (len(value) > 500) {
        ctx.addIssue({ code: 'custom', message: `Compatibility is too long (${len(value)} characters). Maximum is 500 characters.` });
      }
    })
    .optional(),
});

function firstIssue(stages: [z.ZodType, unknown][]): string | null {
  for (const [schema, value] of stages) {
    const result = schema.safeParse(value);
    if (!result.success) return result.error.issues[0].message;
  }
  return null;
}

/** Basic validation of a skill; returns [valid, message]. */
export function validateSkill(skillPath: string): [boolean, string] {
  const skillMd = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return [false, 'SKILL.md not found'];

  const content = readText(skillMd);
  if (!content.startsWith('---')) return [false, 'No YAML frontmatter found'];

  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return [false, 'Invalid frontmatter format'];

  let frontmatter;
  try {
    frontmatter = new Parser(match[1]).document();
  } catch (e) {
    if (!(e instanceof YamlError)) throw e;
    return [false, `Invalid YAML in frontmatter: ${e.message}`];
  }
  if (!(frontmatter instanceof Map)) return [false, 'Frontmatter must be a YAML dictionary'];

  const fields = Object.fromEntries(frontmatter);
  const problem = firstIssue([
    [Keys, [...frontmatter.keys()]],
    [Presence, fields],
    [Fields, fields],
  ]);
  return problem ? [false, problem] : [true, 'Skill is valid!'];
}

const Argv = z.tuple([z.string()]);

if (isMain(import.meta.url)) {
  const argv = Argv.safeParse(process.argv.slice(2));
  if (!argv.success) {
    console.log('Usage: node quick_validate.ts <skill_directory>');
    process.exit(1);
  }
  const [valid, message] = validateSkill(argv.data[0]);
  console.log(message);
  process.exit(valid ? 0 : 1);
}
