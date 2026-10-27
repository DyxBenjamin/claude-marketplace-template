/**
 * @file Maps file names to MIME types by extension for the eval viewer; exports guessType
 * @tags skill-creator, eval-viewer
 */
// MIME type lookup by file extension (the common subset of Python's mimetypes table).

const TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.doc': 'application/msword',
  '.bin': 'application/octet-stream', '.pdf': 'application/pdf', '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint', '.wasm': 'application/wasm', '.sh': 'application/x-sh',
  '.tar': 'application/x-tar', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.xml': 'application/xml', '.sql': 'application/x-sql',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/x-wav', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.bmp': 'image/bmp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.css': 'text/css', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
  '.md': 'text/markdown', '.txt': 'text/plain', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c',
  '.py': 'text/x-python', '.java': 'text/x-java-source', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t',
};
const SUFFIX_MAP: Record<string, string> = { '.svgz': '.svg.gz', '.tgz': '.tar.gz', '.taz': '.tar.gz', '.tz': '.tar.gz', '.tbz2': '.tar.bz2', '.txz': '.tar.xz' };
const ENCODINGS = new Set(['.gz', '.Z', '.bz2', '.xz', '.br']);

/** posixpath.splitext. */
function splitExt(p: string): [string, string] {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot > slash) {
    for (let i = slash + 1; i < dot; i++) if (p[i] !== '.') return [p.slice(0, dot), p.slice(dot)];
  }
  return [p, ''];
}

/** MIME type for a file name, or null when unknown. */
export function guessType(file: string): string | null {
  let [base, ext] = splitExt(file);
  if (ext in SUFFIX_MAP) [base, ext] = splitExt(base + SUFFIX_MAP[ext]);
  while (ENCODINGS.has(ext)) [base, ext] = splitExt(base);
  return TYPES[ext] ?? TYPES[ext.toLowerCase()] ?? null;
}
