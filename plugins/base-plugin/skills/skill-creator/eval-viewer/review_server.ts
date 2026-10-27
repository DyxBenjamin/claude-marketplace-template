/**
 * @file Serves the eval review page and feedback API over HTTP; exports createServer, listen, killPort, openBrowser
 * @tags skill-creator, eval-viewer, http-server
 * @related plugins/base-plugin/skills/skill-creator/eval-viewer/review_data.ts
 */
// HTTP server for the review page: page, feedback API, port handling, browser launch.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dumpJson, isDict, JSONDecodeError, parseJson, pyHas } from '../scripts/py_json.ts';
import { check, FeedbackFile, SchemaError } from '../scripts/schemas.ts';
import { findRuns, generateHtml, loadBenchmark } from './review_data.ts';
import type { Previous } from './review_data.ts';
import { parseChecked, readBytes } from '../scripts/utils.ts';

class ValueError extends Error {}

const EXPLAIN: Record<number, [string, string]> = {
  404: ['Not Found', 'Nothing matches the given URI'],
  501: ['Not Implemented', 'Server does not support this operation'],
};

/** Kill any process listening on the given port. */
export function killPort(port: number): void {
  const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000 });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') process.stderr.write('Note: lsof not found, cannot check if port is in use\n');
    return;
  }
  const out = (result.stdout ?? '').trim();
  for (const pid of out.split('\n')) {
    if (!pid.trim()) continue;
    try {
      process.kill(Number(pid.trim()), 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  if (out) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

function sendError(res: ServerResponse, code: number, message: string = EXPLAIN[code][0]): void {
  const body = Buffer.from(`<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <style type="text/css">
            :root {
                color-scheme: light dark;
            }
        </style>
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: ${code}</p>
        <p>Message: ${message}.</p>
        <p>Error code explanation: ${code} - ${EXPLAIN[code][1]}.</p>
    </body>
</html>
`);
  res.statusMessage = message;
  res.writeHead(code, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': body.length, Connection: 'close' });
  res.end(body);
}

function sendBody(res: ServerResponse, code: number, type: string, body: Buffer): void {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}

export type ServerContext = {
  workspace: string;
  skillName: string;
  feedbackPath: string;
  previous: Previous;
  benchmarkPath: string | null;
};

/**
 * Create the review server. The page is regenerated on each load so that refreshing
 * the browser picks up new eval outputs without restarting.
 */
export function createServer({ workspace, skillName, feedbackPath, previous, benchmarkPath }: ServerContext): Server {
  const onGet = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/' || req.url === '/index.html') {
      // Regenerate HTML on each request (re-scans workspace for new outputs)
      const runs = findRuns(workspace);
      const benchmark = loadBenchmark(benchmarkPath);
      sendBody(res, 200, 'text/html; charset=utf-8', Buffer.from(generateHtml(runs, skillName, previous, benchmark)));
    } else if (req.url === '/api/feedback') {
      const data = fs.existsSync(feedbackPath) ? readBytes(feedbackPath) : Buffer.from('{}');
      if (fs.existsSync(feedbackPath)) parseChecked(FeedbackFile, data.toString('utf8'), 'feedback.json');
      sendBody(res, 200, 'application/json', data);
    } else {
      sendError(res, 404);
    }
  };

  const save = (body: Buffer): [number, string] => {
    try {
      const data = parseJson(body.toString('utf8'));
      if (!isDict(data) || !pyHas(data, 'reviews')) throw new ValueError("Expected JSON object with 'reviews' key");
      fs.writeFileSync(feedbackPath, dumpJson(check(FeedbackFile, data, 'feedback'), 2) + '\n');
      return [200, '{"ok":true}'];
    } catch (err) {
      const known = err instanceof ValueError || err instanceof SchemaError || err instanceof JSONDecodeError;
      if (!(known || (err as NodeJS.ErrnoException).code)) throw err;
      return [500, dumpJson({ error: (err as Error).message })];
    }
  };

  const onPost = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/api/feedback') return sendError(res, 404);
    const length = parseInt(req.headers['content-length'] ?? '0', 10);
    if (Number.isNaN(length)) return req.destroy();
    const chunks: Buffer[] = [];
    let got = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const [code, resp] = save(Buffer.concat(chunks).subarray(0, length));
      sendBody(res, code, 'application/json', Buffer.from(resp));
    };
    if (length <= 0) return finish();
    req.on('data', (chunk) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= length) finish();
    });
    req.on('end', finish);
  };

  return http.createServer((req, res) => {
    try {
      if (req.url?.startsWith('//')) req.url = '/' + req.url.replace(/^\/+/, '');
      if (req.method === 'GET') onGet(req, res);
      else if (req.method === 'POST') onPost(req, res);
      else sendError(res, 501, `Unsupported method ('${req.method}')`);
    } catch (err) {
      if (err instanceof SchemaError) {
        process.stderr.write(`Error: ${err.message}\n`);
        sendBody(res, 500, 'text/plain; charset=utf-8', Buffer.from(err.message));
        return;
      }
      process.stderr.write(`${(err as Error).stack}\n`);
      req.destroy();
    }
  });
}

/**
 * Listen on a loopback port (0 picks a free one).
 * @returns {Promise<number>} the bound port
 */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Open a URL in the default browser; failures are ignored. */
export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available
  }
}
