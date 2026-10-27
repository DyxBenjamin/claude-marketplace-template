/**
 * @file Parses the YAML subset of SKILL.md frontmatter; exports Parser, YamlError, typeName and truthy
 * @tags skill-creator, yaml
 */
// Small YAML subset parser for SKILL.md frontmatter: scalars, quoted/folded/literal strings, lists and maps.
export class YamlError extends Error {}
class PyDate {
  readonly hasTime: boolean;
  constructor(hasTime: boolean) {
    this.hasTime = hasTime;
  }
}

/** A parsed YAML node: ints are bigint, floats are number, maps keep insertion order. */
export type YamlValue = null | boolean | bigint | number | string | PyDate | YamlValue[] | Map<unknown, YamlValue>;
type Quoted = { value: string; end: number };
type Key = { key: string; rest: string };
type Flow = { value: YamlValue; pos: number };

const isBlank = (line: string): boolean => /^\s*(#.*)?$/.test(line);
const isSeqItem = (s: string): boolean => /^-(\s|$)/.test(s);

function indentOf(line: string): number {
  const m = (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
  if (m.includes('\t')) throw new YamlError("found character '\\t' that cannot start any token");
  return m.length;
}

const ESCAPES: Record<string, string> = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 };

// Folds the line breaks inside a quoted scalar: one break is a space, n breaks are n-1 newlines.
function foldBreaks(text: string, i: number, out: string): { out: string; next: number } {
  let n = 0;
  let j = i;
  while (j < text.length && /[ \t\n]/.test(text[j])) {
    if (text[j] === '\n') n++;
    j++;
  }
  return { out: out.replace(/[ \t]+$/, '') + (n === 1 ? ' ' : '\n'.repeat(n - 1)), next: j };
}

// Parses a quoted scalar starting at text[start]; returns null when it is not closed yet.
function parseQuoted(text: string, start: number): Quoted | null {
  const q = text[start];
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === q) {
      if (q === "'" && text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    if (c === '\n') {
      const r = foldBreaks(text, i, out);
      out = r.out;
      i = r.next;
    } else if (c === '\\' && q === '"') {
      const e = text[i + 1];
      if (e === undefined) return null;
      if (e === '\n') {
        i += 2;
        while (i < text.length && /[ \t]/.test(text[i])) i++;
      } else if (e in HEX_ESCAPES) {
        const hex = text.slice(i + 2, i + 2 + HEX_ESCAPES[e]);
        if (hex.length < HEX_ESCAPES[e]) return null;
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new YamlError('expected escape sequence of hexadecimal numbers');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + hex.length;
      } else if (e in ESCAPES) {
        out += ESCAPES[e];
        i += 2;
      } else throw new YamlError(`found unknown escape character '${e}'`);
    } else {
      out += c;
      i++;
    }
  }
  return null;
}

const INT_RES = [/^[-+]?0b[01_]+$/, /^[-+]?0[0-7_]+$/, /^[-+]?(0|[1-9][0-9_]*)$/, /^[-+]?0x[0-9a-fA-F_]+$/, /^[-+]?[1-9][0-9_]*(:[0-5]?[0-9])+$/];
const FLOAT_RES = [
  /^[-+]?[0-9][0-9_]*\.[0-9_]*([eE][-+][0-9]+)?$/,
  /^\.[0-9_]+([eE][-+][0-9]+)?$/,
  /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*$/,
  /^[-+]?\.(inf|Inf|INF)$/,
  /^\.(nan|NaN|NAN)$/,
];

// Resolves a plain scalar to null, boolean, bigint (int), number (float), PyDate or string.
function resolve(s: string): YamlValue {
  if (s === '' || /^(~|null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
  if (INT_RES.some((r) => r.test(s))) return /^[0_:]*$/.test(s.replace(/^[-+]?(0[bx])?/, '')) ? 0n : 1n;
  if (FLOAT_RES.some((r) => r.test(s))) {
    if (/nan/i.test(s)) return NaN;
    return /inf/i.test(s) ? Infinity : /^[-+]?[0_.:]*([eE].*)?$/.test(s) ? 0 : 0.5;
  }
  if (/^\d{4}-\d\d?-\d\d?$/.test(s)) return new PyDate(false);
  if (/^\d{4}-\d\d?-\d\d?([Tt]|[ \t]+)\d\d?:\d\d:\d\d(\.\d*)?(\s*(Z|[-+]\d\d?(:\d\d)?))?$/.test(s)) return new PyDate(true);
  return s;
}

// Returns {key, rest} when the content starts a block mapping entry, else null.
function findKey(content: string): Key | null {
  const first = content[0];
  if (first === '"' || first === "'") {
    const q = parseQuoted(content, 0);
    if (!q) return null;
    const m = /^[ \t]*:([ \t]+|$)/.exec(content.slice(q.end));
    return m ? { key: q.value, rest: content.slice(q.end + m[0].length) } : null;
  }
  if (/^[[\]{}|>&*!%@`,#]/.test(first)) return null;
  const m = /^((?:[^:#]|:(?![ \t]|$)|(?<=\S)#)+?)[ \t]*:([ \t]+|$)/.exec(content);
  return m ? { key: m[1], rest: content.slice(m[0].length) } : null;
}

const stripComment = (s: string): string => s.replace(/(^|[ \t])#.*$/, '');

// Parses one flow collection or scalar from s at pos.
function parseFlow(s: string, pos: number): Flow {
  const ws = (p: number) => {
    while (p < s.length && /[\s]/.test(s[p])) p++;
    return p;
  };
  pos = ws(pos);
  const c = s[pos];
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}';
    const arr: YamlValue[] = [];
    const map = new Map<unknown, YamlValue>();
    pos = ws(pos + 1);
    while (s[pos] !== close) {
      if (pos >= s.length) throw new YamlError(`expected the node content, but found '<stream end>'`);
      const key = parseFlow(s, pos);
      pos = ws(key.pos);
      if (c === '{' || (s[pos] === ':' && /[\s,\]]/.test(s[pos + 1] ?? ' '))) {
        let value: YamlValue = null;
        if (s[pos] === ':') {
          pos = ws(pos + 1);
          if (s[pos] !== ',' && s[pos] !== close) {
            const v = parseFlow(s, pos);
            value = v.value;
            pos = ws(v.pos);
          }
        }
        if (c === '{') map.set(key.value, value);
        else arr.push(new Map<unknown, YamlValue>([[key.value, value]]));
      } else arr.push(key.value);
      if (s[pos] === ',') pos = ws(pos + 1);
      else if (s[pos] !== close) throw new YamlError(`expected ',' or '${close}', but found '${s[pos] ?? '<stream end>'}'`);
    }
    return { value: c === '[' ? arr : map, pos: pos + 1 };
  }
  if (c === '"' || c === "'") {
    const q = parseQuoted(s, pos);
    if (!q) throw new YamlError('found unexpected end of stream');
    return { value: q.value, pos: q.end };
  }
  let end = pos;
  while (end < s.length && !',[]{}'.includes(s[end]) && !(s[end] === ':' && /[\s,\]}]/.test(s[end + 1] ?? ' '))) end++;
  if (end === pos && s[pos] !== ',' && s[pos] !== ']' && s[pos] !== '}') throw new YamlError('could not parse flow node');
  return { value: resolve(s.slice(pos, end).trim()), pos: end };
}

function flowBalanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = parseQuoted(text, i);
      if (!q) return false;
      i = q.end - 1;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

export class Parser {
  lines: string[];
  i: number;

  constructor(text: string) {
    this.lines = text.split('\n');
    this.i = 0;
  }

  skipBlank(): boolean {
    while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++;
    return this.i < this.lines.length;
  }

  document(): YamlValue {
    if (!this.skipBlank()) return null;
    const value = this.node(indentOf(this.lines[this.i]));
    if (this.skipBlank()) throw new YamlError('expected <block end>, but found a stray line');
    return value;
  }

  node(ind: number): YamlValue {
    const content = this.lines[this.i].slice(ind);
    if (isSeqItem(content)) return this.seq(ind);
    if (findKey(content)) return this.map(ind);
    this.i++;
    return this.value(content, -1, false);
  }

  map(ind: number): Map<unknown, YamlValue> {
    const map = new Map<unknown, YamlValue>();
    while (this.skipBlank()) {
      const line = this.lines[this.i];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) throw new YamlError('mapping values are not allowed here');
      const kv = findKey(line.slice(ind));
      if (!kv) throw new YamlError("could not find expected ':'");
      this.i++;
      map.set(kv.key, this.value(kv.rest, ind, true));
    }
    return map;
  }

  seq(ind: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (this.skipBlank()) {
      const line = this.lines[this.i];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) throw new YamlError('expected <block end>, but found a nested line');
      const m = /^-(\s+|$)/.exec(line.slice(ind));
      if (!m) break;
      const rest = line.slice(ind + m[0].length);
      if (stripComment(rest).trim() === '') {
        this.i++;
        arr.push(this.value('', ind, false));
      } else if (isSeqItem(rest) || findKey(rest)) {
        const inner = ind + m[0].length;
        this.lines[this.i] = ' '.repeat(inner) + rest;
        arr.push(this.node(inner));
      } else {
        this.i++;
        arr.push(this.value(rest, ind, false));
      }
    }
    return arr;
  }

  // Value text after "key:" or "- "; parent is the indent of the owning entry.
  value(text: string, parent: number, inMap: boolean): YamlValue {
    text = text.replace(/^[ \t]+/, '');
    if (text === '' || text.startsWith('#')) {
      if (!this.skipBlank()) return null;
      const n = indentOf(this.lines[this.i]);
      if (n > parent) return this.node(n);
      if (inMap && n === parent && isSeqItem(this.lines[this.i].slice(n))) return this.seq(n);
      return null;
    }
    const first = text[0];
    if (/^[|>][-+0-9]*[ \t]*(#.*)?$/.test(text)) return this.blockScalar(text, parent);
    if (first === '"' || first === "'") {
      let raw = text;
      let q = parseQuoted(raw, 0);
      while (!q) {
        if (this.i >= this.lines.length) throw new YamlError('found unexpected end of stream');
        raw += `\n${this.lines[this.i++]}`;
        q = parseQuoted(raw, 0);
      }
      this.endOfValue(raw.slice(q.end));
      return q.value;
    }
    if (first === '[' || first === '{') {
      let raw = text;
      while (!flowBalanced(raw)) {
        if (this.i >= this.lines.length) throw new YamlError('found unexpected end of stream');
        raw += `\n${this.lines[this.i++]}`;
      }
      const r = parseFlow(raw, 0);
      this.endOfValue(raw.slice(r.pos));
      return r.value;
    }
    if (/^[&*!]/.test(first)) throw new YamlError('anchors, aliases and tags are not supported');
    if (/^[%@`]/.test(first)) throw new YamlError(`found character '${first}' that cannot start any token`);
    return this.plain(text, parent);
  }

  endOfValue(rest: string): void {
    if (!/^\s*(#.*)?$/.test(rest)) throw new YamlError(`expected <block end>, but found '${rest.trim()[0]}'`);
  }

  plain(text: string, parent: number): YamlValue {
    const parts = [stripComment(text).trimEnd()];
    const commented = stripComment(text) !== text;
    let blanks = 0;
    let j = this.i;
    while (!commented && j < this.lines.length) {
      const line = this.lines[j];
      if (line.trim() === '') {
        blanks++;
        j++;
        continue;
      }
      if (/^\s*#/.test(line) || indentOf(line) <= parent) break;
      const body = stripComment(line.trim()).trimEnd();
      parts.push(blanks ? '\n'.repeat(blanks) : ' ', body);
      blanks = 0;
      this.i = ++j;
      if (stripComment(line.trim()) !== line.trim()) break;
    }
    const s = parts.join('').replace(/ \n/g, '\n');
    if (/:([ \t]|$)/.test(s) && !s.includes('\n')) throw new YamlError('mapping values are not allowed here');
    return parts.length === 1 ? resolve(s) : s;
  }

  blockScalar(header: string, parent: number): string {
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const digit = /[1-9]/.exec(header.split('#')[0]);
    let blockIndent = digit ? Math.max(parent, 0) + Number(digit[0]) : null;
    const body: string[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === '') {
        body.push(blockIndent === null ? '' : line.slice(blockIndent));
        this.i++;
        continue;
      }
      const n = indentOf(line);
      if (n <= parent || (blockIndent !== null && n < blockIndent)) break;
      if (blockIndent === null) blockIndent = n;
      body.push(line.slice(blockIndent));
      this.i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    const folded = header[0] === '>';
    let out = '';
    let prev: string | null = null;
    let blanks = 0;
    for (const l of body) {
      if (l === '') {
        blanks++;
        continue;
      }
      if (prev === null) out += '\n'.repeat(blanks);
      else if (!folded) out += '\n'.repeat(blanks + 1);
      else {
        const special = /^[ \t]/.test(l) || /^[ \t]/.test(prev);
        out += !special && !blanks ? ' ' : '\n'.repeat(special ? blanks + 1 : blanks);
      }
      out += l;
      prev = l;
      blanks = 0;
    }
    if (chomp === 'keep') return out + '\n'.repeat(trailing + (body.length ? 1 : 0));
    return chomp === 'clip' && body.length ? `${out}\n` : out;
  }
}

export function typeName(v: unknown): string {
  if (v === null) return 'NoneType';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return 'float';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'dict';
  return (v as PyDate).hasTime ? 'datetime' : 'date';
}

export const truthy = (v: unknown): boolean =>
  !(v === null || v === '' || v === false || v === 0n || v === 0 || (Array.isArray(v) && !v.length) || (v instanceof Map && !v.size));
