'use strict';

const fs = require('fs');

/**
 * Minimal .env reader for local development: `KEY=value` per line, `#`
 * comments, optional surrounding quotes. Values already present in the real
 * environment win, so running with exported variables (or in a container)
 * never gets overridden by a stale file.
 *
 * Kept in-tree rather than pulling in `dotenv`, so `npm install` needs nothing
 * but Express.
 *
 * @param {string} filePath Absolute path to the .env file.
 */
module.exports = function loadEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return; // No .env file is normal when the environment is set another way.
  }

  text.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;

    const eq = trimmed.indexOf('=');
    if (eq < 1) return;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.charAt(value.length - 1) === quote) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
};
