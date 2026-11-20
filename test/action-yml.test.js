'use strict';

// GitHub evaluates ${{ }} everywhere in an action's action.yml, even in descriptions,
// and only a few contexts are allowed there. "secrets" and "vars" are not, so one
// example like "pass ${{ toJSON(secrets) }}" stops every deploy at "Set up job".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const action of ['resolve', 'deploy']) {
  test(`${action}/action.yml has no \${{ }} expressions`, () => {
    const file = path.join(__dirname, '..', action, 'action.yml');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const found = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes('${{'));
    assert.deepEqual(found, [], `action.yml line ${found.map((f) => f.number).join(', ')} uses \${{ }}`);
  });
}
