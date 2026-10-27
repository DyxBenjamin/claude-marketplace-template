/**
 * @file Parses and dumps JSON keeping the int/float distinction, with Python-style repr, rounding and number formatting
 * @tags skill-creator, json
 */
// JSON with float/int distinction and Python-style text: parse, dump, repr and number formatting.

/** A JSON number written with a fraction or exponent (Python float). Plain numbers are ints. */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** A JSON number as parsed: a plain number (int) or a PyFloat. */
export type PyNum = number | PyFloat;

/** A parsed JSON object: a Map when a key is integer-like, else a plain object. */
export type PyDict = Map<string, unknown> | Record<string, unknown>;

/** Raised by parseJson; message mirrors Python's json.JSONDecodeError. */
export class JSONDecodeError extends Error {
  constructor(msg: string, doc: string, pos: number) {
    const before = doc.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    super(`${msg}: line ${line} column ${col} (char ${pos})`);
    this.name = 'JSONDecodeError';
  }
}

/** Numeric value of an int or PyFloat. */
export const num = (v: PyNum): number => (v instanceof PyFloat ? v.value : v);
export const isDict = (v: unknown): v is PyDict =>
  v instanceof Map || (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat));
export const pyHas = (obj: unknown, key: string): boolean =>
  obj instanceof Map ? obj.has(key) : isDict(obj) && Object.hasOwn(obj, key);
export const pyEntries = (obj: PyDict): [string, unknown][] => (obj instanceof Map ? [...obj] : Object.entries(obj));

/** Python truthiness. */
export function truthy(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === '') return false;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

const WS = ' \t\n\r';
const NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const INDEX_KEY = /^(?:0|[1-9]\d*)$/;

class Stop extends Error {
  readonly pos: number;
  constructor(pos: number) {
    super('stop');
    this.pos = pos;
  }
}

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.includes(s[i])) i++;
  return i;
}

function scanString(s: string, end: number): [string, number] {
  const begin = end - 1;
  let out = '';
  for (;;) {
    let i = end;
    while (i < s.length && s[i] !== '"' && s[i] !== '\\' && s.charCodeAt(i) >= 0x20) i++;
    out += s.slice(end, i);
    if (i >= s.length) throw new JSONDecodeError('Unterminated string starting at', s, begin);
    const term = s[i];
    if (term === '"') return [out, i + 1];
    if (term !== '\\') throw new JSONDecodeError('Invalid control character at', s, i);
    i++;
    if (i >= s.length) throw new JSONDecodeError('Unterminated string starting at', s, begin);
    const esc = s[i];
    if (esc !== 'u') {
      if (!(esc in ESCAPES)) throw new JSONDecodeError('Invalid \\escape', s, i - 1);
      out += ESCAPES[esc];
      end = i + 1;
    } else {
      const hex = s.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JSONDecodeError('Invalid \\uXXXX escape', s, i);
      out += String.fromCharCode(parseInt(hex, 16));
      end = i + 5;
    }
  }
}

function scanValue(s: string, i: number): [unknown, number] {
  const c = s[i];
  if (c === '"') return scanString(s, i + 1);
  if (c === '{') return scanObject(s, i + 1);
  if (c === '[') return scanArray(s, i + 1);
  if (c === 'n' && s.startsWith('null', i)) return [null, i + 4];
  if (c === 't' && s.startsWith('true', i)) return [true, i + 4];
  if (c === 'f' && s.startsWith('false', i)) return [false, i + 5];
  NUMBER.lastIndex = i;
  const m = c !== undefined ? NUMBER.exec(s) : null;
  if (m) {
    const end = i + m[0].length;
    return m[2] || m[3] ? [new PyFloat(parseFloat(m[0])), end] : [Number(m[1]), end];
  }
  if (c === 'N' && s.startsWith('NaN', i)) return [new PyFloat(NaN), i + 3];
  if (c === 'I' && s.startsWith('Infinity', i)) return [new PyFloat(Infinity), i + 8];
  if (c === '-' && s.startsWith('-Infinity', i)) return [new PyFloat(-Infinity), i + 9];
  throw new Stop(i);
}

function valueAt(s: string, i: number): [unknown, number] {
  try {
    return scanValue(s, i);
  } catch (err) {
    if (err instanceof Stop) throw new JSONDecodeError('Expecting value', s, err.pos);
    throw err;
  }
}

function scanObject(s: string, end: number): [unknown, number] {
  const pairs: [string, unknown][] = [];
  end = skipWs(s, end);
  if (s[end] === '}') return [{}, end + 1];
  if (s[end] !== '"') throw new JSONDecodeError('Expecting property name enclosed in double quotes', s, end);
  end++;
  for (;;) {
    let key: string;
    [key, end] = scanString(s, end);
    end = skipWs(s, end);
    if (s[end] !== ':') throw new JSONDecodeError("Expecting ':' delimiter", s, end);
    end = skipWs(s, end + 1);
    let value: unknown;
    [value, end] = valueAt(s, end);
    pairs.push([key, value]);
    end = skipWs(s, end);
    const next = s[end];
    end++;
    if (next === '}') break;
    if (next !== ',') throw new JSONDecodeError("Expecting ',' delimiter", s, end - 1);
    const comma = end - 1;
    end = skipWs(s, end);
    if (s[end] === '}') throw new JSONDecodeError('Illegal trailing comma before end of object', s, comma);
    if (s[end] !== '"') throw new JSONDecodeError('Expecting property name enclosed in double quotes', s, end);
    end++;
  }
  // Integer-like keys would be reordered by a plain object; keep insertion order with a Map.
  if (pairs.some(([k]) => INDEX_KEY.test(k) || k === '__proto__')) return [new Map(pairs), end];
  return [Object.fromEntries(pairs), end];
}

function scanArray(s: string, end: number): [unknown, number] {
  const values: unknown[] = [];
  end = skipWs(s, end);
  if (s[end] === ']') return [values, end + 1];
  for (;;) {
    let value: unknown;
    [value, end] = valueAt(s, end);
    values.push(value);
    end = skipWs(s, end);
    const next = s[end];
    end++;
    if (next === ']') break;
    if (next !== ',') throw new JSONDecodeError("Expecting ',' delimiter", s, end - 1);
    const comma = end - 1;
    end = skipWs(s, end);
    if (s[end] === ']') throw new JSONDecodeError('Illegal trailing comma before end of array', s, comma);
  }
  return [values, end];
}

/**
 * Parse JSON text like Python's json.loads: floats become PyFloat, objects with integer-like keys become Maps.
 * @throws {JSONDecodeError}
 */
export function parseJson(text: string): unknown {
  const start = skipWs(text, 0);
  const [value, end] = valueAt(text, start);
  const rest = skipWs(text, end);
  if (rest !== text.length) throw new JSONDecodeError('Extra data', text, rest);
  return value;
}

/** Python repr() of a float. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, exp] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const decpt = Number(exp) + 1;
  const sign = x < 0 ? '-' : '';
  if (decpt > 16 || decpt <= -4) {
    const e = decpt - 1;
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** Python repr() of a str. */
function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + quote;
}

/** Python repr() of a parsed JSON value. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return strRepr(v);
  if (typeof v === 'number') return String(v);
  if (v instanceof PyFloat) return floatRepr(v.value);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${pyEntries(v as PyDict).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

/** Python str() of a parsed JSON value. */
export const pyStr = (v: unknown): string => (typeof v === 'string' ? v : pyRepr(v));

function dumpString(s: string): string {
  return `"${s.replace(/[\\"]|[^ -~]/g, (ch: string) => {
    if (ch === '\\') return '\\\\';
    if (ch === '"') return '\\"';
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    if (ch === '\b') return '\\b';
    if (ch === '\f') return '\\f';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;
}

/** Python json.dumps (ensure_ascii on); indent is a number of spaces or null for the compact ", " / ": " form. */
export function dumpJson(value: unknown, indent: number | null = null, level = 0): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return dumpString(value);
  if (typeof value === 'number') return String(value);
  if (value instanceof PyFloat) return floatRepr(value.value);
  const isList = Array.isArray(value);
  const items: [string | null, unknown][] = isList
    ? (value as unknown[]).map((v): [null, unknown] => [null, v])
    : pyEntries(value as PyDict).map(([k, v]): [string, unknown] => [dumpString(typeof k === 'string' ? k : String(k)), v]);
  const [open, close] = isList ? ['[', ']'] : ['{', '}'];
  if (!items.length) return open + close;
  const parts = (inner: number) =>
    items.map(([k, v]) => (k === null ? '' : `${k}: `) + dumpJson(v, indent, inner));
  if (indent === null) return open + parts(level).join(', ') + close;
  const pad = '\n' + ' '.repeat(indent * (level + 1));
  return open + pad + parts(level + 1).join(`,${pad}`) + '\n' + ' '.repeat(indent * level) + close;
}

/** Python f"{x:.{digits}f}" with round-half-even on the exact binary value. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const sign = x < 0 || Object.is(x, -0) ? '-' : '';
  const abs = Math.abs(x);
  let out = abs.toFixed(digits);
  const full = abs.toFixed(Math.min(100, digits + 40));
  const point = full.indexOf('.');
  const tail = full.slice(point + 1 + digits);
  if (/^50*$/.test(tail)) {
    const kept = full.slice(0, digits ? point + 1 + digits : point);
    const last = kept.replace('.', '').slice(-1);
    if (Number(last) % 2 === 0) out = kept;
  }
  return sign + out;
}

/** Same as pyFixed with a leading + for non-negative values. */
export const pyFixedSigned = (x: number, digits: number): string => {
  const s = pyFixed(x, digits);
  return s.startsWith('-') ? s : `+${s}`;
};

/** Python round(x, digits) of a float. */
export const pyRound = (x: number, digits: number): number => parseFloat(pyFixed(x, digits));

/** Python str.title(). */
export function pyTitle(s: string): string {
  let cased = false;
  let out = '';
  for (const ch of s) {
    const isCased = ch.toLowerCase() !== ch.toUpperCase();
    out += isCased ? (cased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    cased = isCased;
  }
  return out;
}

/** Python sum() of ints and floats (compensated for floats). */
export function pySum(values: PyNum[]): number {
  if (!values.some((v) => v instanceof PyFloat)) return (values as number[]).reduce((a, b) => a + b, 0);
  let total = 0;
  let c = 0;
  for (const v of values) {
    const x = num(v);
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return c && Number.isFinite(c) ? total + c : total;
}
