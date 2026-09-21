import { mkdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

/**
 * Check that the data directory can actually be used, before anything tries to
 * store something in it.
 *
 * A service that cannot write its data is broken, but the failure surfaces as
 * an EACCES on a temporary file deep inside a write, which says nothing about
 * the cause. This runs one real create-write-delete and turns a failure into a
 * sentence naming the directory, the user and the command that fixes it.
 *
 * @param {string} dataDir
 * @returns {Promise<{ok: true} | {ok: false, reason: string, fix: string|null}>}
 */
export async function checkDataDir(dataDir) {
  const dir = path.resolve(dataDir);
  const who = currentUser();
  const chown = `sudo chown -R ${who}:${who} ${dir} && sudo chmod 700 ${dir}`;

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      reason: `The data directory ${dir} does not exist and cannot be created (${err.code ?? err.message}).`,
      fix: err.code === 'EACCES' || err.code === 'EPERM'
        ? `sudo mkdir -p ${dir} && ${chown}`
        : null,
    };
  }

  const probe = path.join(dir, `.write-probe.${process.pid}`);
  try {
    await writeFile(probe, '', { mode: 0o600 });
    await rm(probe, { force: true });
    return { ok: true };
  } catch (err) {
    await rm(probe, { force: true }).catch(() => {});
    const messages = {
      EACCES: `The data directory ${dir} is not writable by user ${who}.`,
      EPERM: `The data directory ${dir} is not writable by user ${who}.`,
      EROFS: `The data directory ${dir} is on a read-only filesystem.`,
      ENOSPC: 'The disk is full.',
      EDQUOT: 'The disk quota is exceeded.',
    };
    return {
      ok: false,
      reason: messages[err.code] ?? `The data directory ${dir} cannot be written (${err.code ?? err.message}).`,
      fix: err.code === 'EACCES' || err.code === 'EPERM' ? chown : null,
    };
  }
}

function currentUser() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? String(process.getuid?.() ?? 'the service user');
  }
}
