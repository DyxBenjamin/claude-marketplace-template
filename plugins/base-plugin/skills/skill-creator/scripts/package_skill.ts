#!/usr/bin/env node
/**
 * @file Validates a skill folder and zips it into a distributable .skill archive; exports packageSkill, shouldExclude
 * @tags skill-creator, packaging
 * @related plugins/base-plugin/skills/skill-creator/references/packaging.md, plugins/base-plugin/skills/skill-creator/scripts/quick_validate.ts
 */
// Skill Packager - Creates a distributable .skill file of a skill folder
//
// Usage:
//   node package_skill.ts <path/to/skill-folder> [output-directory]
//
// Example:
//   node package_skill.ts skills/public/my-skill
//   node package_skill.ts skills/public/my-skill ./dist
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from '../vendor/zod.generated.js';
import { validateSkill } from './quick_validate.ts';
import { isMain } from './utils.ts';

// Patterns to exclude when packaging skills.
const EXCLUDE_DIRS = new Set(['__pycache__', 'node_modules']);
const EXCLUDE_SUFFIXES = ['.pyc'];
const EXCLUDE_FILES = new Set(['.DS_Store']);
// Directories excluded only at the skill root (not when nested deeper).
const ROOT_EXCLUDE_DIRS = new Set(['evals']);

/** Checks if a path (relative to the skill's parent folder) should be excluded from packaging. */
export function shouldExclude(relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts.some((part) => EXCLUDE_DIRS.has(part))) return true;
  // parts[0] is the skill folder name and parts[1] (if present) is the first subdir.
  if (parts.length > 1 && ROOT_EXCLUDE_DIRS.has(parts[1])) return true;
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(name)) return true;
  return EXCLUDE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; day: number } {
  if (date.getFullYear() < 1980) throw new Error('ZIP does not support timestamps before 1980');
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

type ZipEntry = { name: string; data: Buffer; mtime: Date; mode: number };

/** Builds a ZIP archive (deflate) from entries of {name, data, mtime, mode}. */
function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mtime, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = nameBuf.length === name.length ? 0 : 0x800;
    const packed = zlib.deflateRawSync(data);
    const { time, day } = dosDateTime(mtime);
    const crc = crc32(data);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error('File size too large for ZIP without zip64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

// Lists files under dir: each directory's entries, then its subdirectories in turn.
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift() as string;
    const subdirs: string[] = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) subdirs.push(full);
      else if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isFile())) files.push(full);
    }
    queue.unshift(...subdirs);
  }
  return files;
}

/**
 * Packages a skill folder (vendor/ included, so the skill runs alone) into a .skill file.
 * @param skillPath Path to the skill folder
 * @param outputDir Output directory for the .skill file (defaults to the current directory)
 * @returns Path to the created .skill file, or null if error
 */
export function packageSkill(skillPath: string, outputDir: string | null = null): string | null {
  skillPath = path.resolve(skillPath);

  if (!fs.existsSync(skillPath)) {
    console.log(`❌ Error: Skill folder not found: ${skillPath}`);
    return null;
  }

  if (!fs.statSync(skillPath).isDirectory()) {
    console.log(`❌ Error: Path is not a directory: ${skillPath}`);
    return null;
  }

  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.log(`❌ Error: SKILL.md not found in ${skillPath}`);
    return null;
  }

  console.log('🔍 Validating skill...');
  const [valid, message] = validateSkill(skillPath);
  if (!valid) {
    console.log(`❌ Validation failed: ${message}`);
    console.log('   Please fix the validation errors before packaging.');
    return null;
  }
  console.log(`✅ ${message}\n`);

  const skillName = path.basename(skillPath);
  let outputPath: string;
  if (outputDir) {
    outputPath = path.resolve(outputDir);
    fs.mkdirSync(outputPath, { recursive: true });
  } else {
    outputPath = process.cwd();
  }

  const skillFilename = path.join(outputPath, `${skillName}.skill`);

  try {
    const entries: ZipEntry[] = [];
    const base = path.dirname(skillPath);
    for (const filePath of listFiles(skillPath)) {
      const arcname = path.relative(base, filePath).split(path.sep).join('/');
      if (shouldExclude(arcname)) {
        console.log(`  Skipped: ${arcname}`);
        continue;
      }
      const stat = fs.statSync(filePath);
      entries.push({ name: arcname, data: fs.readFileSync(filePath), mtime: stat.mtime, mode: stat.mode });
      console.log(`  Added: ${arcname}`);
    }
    fs.writeFileSync(skillFilename, buildZip(entries));

    console.log(`\n✅ Successfully packaged skill to: ${skillFilename}`);
    return skillFilename;
  } catch (e) {
    console.log(`❌ Error creating .skill file: ${(e as Error).message}`);
    return null;
  }
}

const Argv = z.array(z.string()).min(1);

function main() {
  const argv = Argv.safeParse(process.argv.slice(2));
  if (!argv.success) {
    console.log('Usage: node package_skill.ts <path/to/skill-folder> [output-directory]');
    console.log('\nExample:');
    console.log('  node package_skill.ts skills/public/my-skill');
    console.log('  node package_skill.ts skills/public/my-skill ./dist');
    process.exit(1);
  }

  const [skillPath, outputDir = null] = argv.data;

  console.log(`📦 Packaging skill: ${skillPath}`);
  if (outputDir) console.log(`   Output directory: ${outputDir}`);
  console.log();

  process.exit(packageSkill(skillPath, outputDir) ? 0 : 1);
}

if (isMain(import.meta.url)) main();
