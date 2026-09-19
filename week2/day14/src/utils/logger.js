import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Structured logging: one JSON object per line.
 *
 * Lines go to stdout/stderr (the systemd journal in production) and, when a log
 * directory is configured and writable, to `<LOG_DIR>/app.log`, which is
 * rotated by size. Fields whose name looks like a credential are replaced with
 * "[redacted]" before anything is written, so a careless `logger.info(..., { apiKey })`
 * cannot leak a secret. Conversation text is never passed to the logger by the
 * application — only lengths, ids and states.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_FIELD = /^(api[-_]?key|authorization|password|passwd|secret|client[-_]?secret|(access|auth|bearer|refresh)[-_]?token|cookie)$/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})/g;

export function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]');
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== 'object' || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

function serializeError(err) {
  const out = { name: err.name, message: redact(String(err.message)) };
  if (err.code !== undefined) out.code = err.code;
  if (err.status !== undefined) out.status = err.status;
  if (err.stack) out.stack = redact(err.stack);
  if (err.cause) out.cause = err.cause instanceof Error ? serializeError(err.cause) : redact(err.cause);
  return out;
}

class RotatingFile {
  constructor(file, { maxBytes, maxFiles }) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.size = fileSize(file);
    this.stream = this.#open();
  }

  #open() {
    const stream = createWriteStream(this.file, { flags: 'a', mode: 0o600 });
    stream.on('error', (err) => {
      process.stderr.write(`Log file ${this.file} is not writable (${err.code}); logging to stdout only.\n`);
      this.broken = true;
    });
    return stream;
  }

  write(line) {
    if (this.broken) return;
    if (this.size + line.length > this.maxBytes) this.#rotate();
    this.stream.write(line);
    this.size += Buffer.byteLength(line);
  }

  #rotate() {
    this.stream.end();
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      try {
        renameSync(i === 1 ? this.file : `${this.file}.${i - 1}`, `${this.file}.${i}`);
      } catch {
        // A missing generation is normal until the files have rotated once.
      }
    }
    this.size = 0;
    this.stream = this.#open();
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * @param {{level?: string, logDir?: string, console?: boolean, maxBytes?: number,
 *          maxFiles?: number, bindings?: object, sink?: (entry: object) => void}} [options]
 *        `sink` receives every entry (used by tests); `console: false` silences stdout.
 */
export function createLogger({
  level = 'info', logDir, console: toConsole = true, maxBytes = 10 * 1024 * 1024, maxFiles = 5, bindings = {}, sink,
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let file = null;
  if (logDir) {
    try {
      file = new RotatingFile(path.join(logDir, 'app.log'), { maxBytes, maxFiles });
    } catch (err) {
      process.stderr.write(`Cannot use log directory ${logDir} (${err.code}); logging to stdout only.\n`);
    }
  }

  function build(base) {
    const emit = (lvl, event, fields = {}) => {
      if (LEVELS[lvl] < threshold) return;
      const entry = redact({ time: new Date().toISOString(), level: lvl, event, ...base, ...fields });
      sink?.(entry);
      const line = `${JSON.stringify(entry)}\n`;
      if (toConsole) (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
      file?.write(line);
    };
    return {
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      child: (extra) => build({ ...base, ...extra }),
      close: () => file?.close() ?? Promise.resolve(),
      logFile: file?.file ?? null,
    };
  }

  return build(bindings);
}

/** A logger that records entries in memory and prints nothing. For tests. */
export function createMemoryLogger() {
  const entries = [];
  const logger = createLogger({ level: 'debug', console: false, sink: (entry) => entries.push(entry) });
  logger.entries = entries;
  return logger;
}
