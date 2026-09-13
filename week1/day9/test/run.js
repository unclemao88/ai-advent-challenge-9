'use strict';

// A dependency-free runner (node:test does not exist on Node 10).
//   npm test              run every test/*.test.js
//   node test/run.js store   run files whose name contains "store"

const fs = require('fs');
const path = require('path');
const harness = require('./harness');

const filter = process.argv[2] || '';
fs.readdirSync(__dirname)
  .filter((f) => /\.test\.js$/.test(f) && f.indexOf(filter) !== -1)
  .sort()
  .forEach((f) => {
    harness.setFile(f);
    require(path.join(__dirname, f));
  });

harness.run();
