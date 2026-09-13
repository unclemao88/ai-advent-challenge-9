'use strict';

const tests = [];
let currentFile = '';

function setFile(file) { currentFile = file; }

function test(name, fn) {
  tests.push({ name: name, fn: fn, file: currentFile });
}

async function run() {
  let failed = 0;
  let lastFile = null;
  for (const t of tests) {
    if (t.file !== lastFile) {
      console.log('\n' + t.file);
      lastFile = t.file;
    }
    try {
      await t.fn();
      console.log('  ok    ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('  FAIL  ' + t.name);
      console.log('        ' + String(err && err.stack || err).split('\n').join('\n        '));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exitCode = failed ? 1 : 0;
}

module.exports = { test, run, setFile };
