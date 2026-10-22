import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ログはターミナル・ファイル (proxy.log)・ブラウザの /__px/logs の3か所で見られる。
// LOG_LEVEL=quiet でページ遷移とエラーだけに絞る (既定は全リクエストを出す)

export const LOG_FILE = process.env.LOG_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'proxy.log');
const QUIET = process.env.LOG_LEVEL === 'quiet';
const MAX_ENTRIES = 1000;

const entries = [];
let seq = 0;
let fileStream = null;
try {
  fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  fileStream.on('error', () => (fileStream = null));
} catch {
  fileStream = null;
}

function time() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level, msg, { verbose = false } = {}) {
  const entry = { id: ++seq, time: time(), level, msg };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const line = `[${entry.time}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  fileStream?.write(line + '\n');
  if (verbose && QUIET) return;
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg) => write('info', msg),
  debug: (msg) => write('debug', msg, { verbose: true }),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
};

/** id より新しいログを返す (ブラウザのログ画面用) */
export function getEntries(afterId = 0) {
  return entries.filter((e) => e.id > afterId);
}
