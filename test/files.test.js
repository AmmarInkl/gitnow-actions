'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileExcludes } = require('../lib/excludes');
const { hashTree, diffFiles } = require('../lib/manifest');
const { renderString, templateValues, renderTemplates } = require('../lib/templates');
const { joinRemote, joinRelative } = require('../lib/paths');
const { tempDir, cleanUp, writeFiles, readTree, silentLog } = require('./helpers');

test.after(cleanUp);

test('exclude patterns work like rsync', () => {
  const excluded = compileExcludes(['node_modules', '*.log', '/storage', 'config/local', 'cache/', '.git']);
  assert.equal(excluded('node_modules/a/b.js'), true);
  assert.equal(excluded('packages/x/node_modules/y.js'), true);
  assert.equal(excluded('logs/app.log'), true);
  assert.equal(excluded('storage/app/file.txt'), true);
  assert.equal(excluded('public/storage/link.txt'), false, '/storage only matches at the top');
  assert.equal(excluded('config/local/db.php'), true);
  assert.equal(excluded('app/config/local/db.php'), false);
  assert.equal(excluded('var/cache/x'), true);
  assert.equal(excluded('.git/HEAD'), true);
  assert.equal(excluded('.gitignore'), false);
  assert.equal(excluded('index.php'), false);
});

test('** crosses folders, * does not', () => {
  const excluded = compileExcludes(['/build/*.map', '/docs/**/draft.md']);
  assert.equal(excluded('build/app.js.map'), true);
  assert.equal(excluded('build/js/app.js.map'), false);
  assert.equal(excluded('docs/a/b/draft.md'), true);
});

test('remote paths are joined safely', () => {
  assert.equal(joinRemote('/', 'production'), '/production');
  assert.equal(joinRemote('/my-site/', '/previews/', 'x'), '/my-site/previews/x');
  assert.equal(joinRelative('public', '', 'x.php'), 'public/x.php');
  assert.throws(() => joinRemote('/a', '../b'), /\.\./);
});

test('templates fill $NAME, ${NAME} and ${NAME.urlEncoded()}', () => {
  const result = renderString('A=$A\nB=${B}\nC=${ C.urlEncoded() }\nD=$MISSING\nE=$$A', { A: '1', B: 'two', C: 'p@ss w/rd' });
  assert.equal(result.text, 'A=1\nB=two\nC=p%40ss%20w%2Frd\nD=$MISSING\nE=$1');
  assert.deepEqual(result.unknown, ['MISSING']);
});

test('GitNow values win over secrets, and GITHUB_TOKEN is never offered', () => {
  const values = templateValues({
    siteUrl: 'https://www.example.com',
    environment: 'production',
    branch: 'main',
    commit: 'abc',
    secrets: { github_token: 'nope', DB_PASSWORD: 'secret', GITNOW_APP_URL: 'evil' },
    variables: { app_name: 'Shop', DB_PASSWORD: 'from-vars' },
  });
  assert.equal(values.GITHUB_TOKEN, undefined);
  assert.equal(values.DB_PASSWORD, 'secret');
  assert.equal(values.APP_NAME, 'Shop');
  assert.equal(values.GITNOW_APP_URL, 'https://www.example.com');
  assert.equal(values.IONOS_APP_URL, 'https://www.example.com');
});

test('template files are rendered into the site without the .template suffix', () => {
  const templates = tempDir();
  const site = tempDir();
  writeFiles(templates, {
    'config.yaml': 'version: 1.0',
    '.env.template': 'APP_URL=$GITNOW_APP_URL\nKEY=$APP_KEY',
    'public/.htaccess.template': 'SetEnv SITE ${GITNOW_APP_URL}',
  });
  const result = renderTemplates(templates, site, { GITNOW_APP_URL: 'https://x.test' });
  assert.deepEqual(result.files, ['.env', 'public/.htaccess']);
  assert.deepEqual(result.unknown, ['APP_KEY']);
  assert.deepEqual(readTree(site), {
    '.env': 'APP_URL=https://x.test\nKEY=$APP_KEY',
    'public/.htaccess': 'SetEnv SITE https://x.test',
  });
});

test('a missing template folder is fine', () => {
  assert.deepEqual(renderTemplates(path.join(tempDir(), 'nope'), tempDir(), {}), { files: [], unknown: [] });
});

test('hashing skips excluded files and folders', async () => {
  const site = tempDir();
  writeFiles(site, { 'index.html': 'hi', 'css/a.css': 'a', 'node_modules/x.js': 'x', '.git/HEAD': 'ref' });
  const files = await hashTree(site, compileExcludes(['node_modules', '.git']), silentLog());
  assert.deepEqual(Object.keys(files), ['css/a.css', 'index.html']);
  assert.equal(files['index.html'], '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4');
});

test('the diff uploads changes, removes what is gone and keeps excluded files', () => {
  const previous = { 'a.txt': '1', 'b.txt': '2', 'old/c.txt': '3', 'old/deep/d.txt': '4', 'storage/x.txt': '5' };
  const current = { 'a.txt': '1', 'b.txt': 'changed', 'new.txt': '6' };
  const diff = diffFiles(previous, current, compileExcludes(['storage']));
  assert.deepEqual(diff.upload, ['b.txt', 'new.txt']);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.remove, ['old/c.txt', 'old/deep/d.txt']);
  assert.deepEqual(diff.removedFolders, ['old/deep', 'old']);
});

test('file names like "constructor" are handled', () => {
  const diff = diffFiles({}, { constructor: 'x', __proto__x: 'y' }, () => false);
  assert.deepEqual(diff.upload, ['__proto__x', 'constructor']);
});

test('symbolic links are skipped with a warning', async (t) => {
  const site = tempDir();
  writeFiles(site, { 'real.txt': 'x' });
  try {
    fs.symlinkSync(path.join(site, 'real.txt'), path.join(site, 'link.txt'));
  } catch {
    t.skip('this system does not allow creating symbolic links');
    return;
  }
  const log = silentLog();
  const files = await hashTree(site, () => false, log);
  assert.deepEqual(Object.keys(files), ['real.txt']);
  assert.match(log.text(), /link.txt: it is a symbolic link/);
});
