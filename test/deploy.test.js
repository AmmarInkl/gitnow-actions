'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deploy } = require('../lib/deploy');
const { resolveEnvironment } = require('../lib/resolve');
const { tempDir, cleanUp, writeFiles, readTree, silentLog, LocalTransport, FakeHooks, makeConfig } = require('./helpers');

test.after(cleanUp);

const laravelLike = makeConfig({
  gitnow: { 'web-root': 'public' },
  deploy: {
    bootstrap: { 'post-deployment-remote-commands': ['php artisan migrate --force'] },
    recurring: {
      excludes: ['storage'],
      'pre-deployment-remote-commands': ['php artisan down'],
      'post-deployment-remote-commands': ['php artisan migrate --force', 'php artisan up'],
    },
  },
});

function setup(config = laravelLike) {
  const server = tempDir();
  const templates = tempDir();
  writeFiles(templates, { '.env.template': 'APP_URL=$GITNOW_APP_URL\nAPP_KEY=$APP_KEY' });
  return {
    server,
    templates,
    transport: new LocalTransport(server),
    config,
    resolved: resolveEnvironment(config, 'main'),
  };
}

async function run(env, siteFiles, { hooks = new FakeHooks(), dryRun = false, log = silentLog(), commit = 'c1' } = {}) {
  const site = tempDir();
  writeFiles(site, siteFiles);
  const result = await deploy({
    config: env.config,
    resolved: env.resolved,
    siteDir: site,
    templateDir: env.templates,
    templateValues: { GITNOW_APP_URL: 'https://www.example.com', APP_KEY: 'base64:key' },
    transport: env.transport,
    hooks,
    meta: { project: 'my-site', branch: 'main', commit, runUrl: 'https://github.com/x/y/actions/runs/1' },
    dryRun,
    log,
  });
  return { result, hooks, log };
}

const production = (env) => readTree(path.join(env.server, 'my-site', 'production'));
const manifest = (env) => JSON.parse(fs.readFileSync(path.join(env.server, 'my-site', '.gitnow', 'production.json'), 'utf8'));

test('the first deploy uploads everything and runs the bootstrap commands', async () => {
  const env = setup();
  const { result, hooks } = await run(env, {
    'public/index.php': '<?php echo 1;',
    'app/Model.php': 'model',
    'storage/app/.gitignore': '*',
  });

  assert.equal(result.mode, 'bootstrap');
  assert.equal(result.uploaded, 4);
  assert.deepEqual(production(env), {
    '.env': 'APP_URL=https://www.example.com\nAPP_KEY=base64:key',
    'app/Model.php': 'model',
    'public/index.php': '<?php echo 1;',
    'storage/app/.gitignore': '*',
  });
  assert.deepEqual(hooks.runs, [{ commands: ['php artisan migrate --force'], title: 'Commands after the upload' }]);

  const saved = manifest(env);
  assert.equal(saved.mode, 'bootstrap');
  assert.equal(saved.commit, 'c1');
  assert.deepEqual(Object.keys(saved.files).sort(), ['.env', 'app/Model.php', 'public/index.php', 'storage/app/.gitignore']);
});

test('later deploys only upload changes, remove what is gone, and leave runtime files alone', async () => {
  const env = setup();
  await run(env, {
    'public/index.php': 'v1',
    'public/old.css': 'old',
    'app/Old.php': 'old',
    'storage/app/.gitignore': '*',
  });

  // The app writes files of its own on the server.
  writeFiles(path.join(env.server, 'my-site', 'production'), {
    'storage/logs/laravel.log': 'log',
    'public/uploads/photo.jpg': 'jpg',
  });

  const log = silentLog();
  const { result, hooks } = await run(env, { 'public/index.php': 'v2', 'app/New.php': 'new' }, { commit: 'c2', log });

  assert.equal(result.mode, 'recurring');
  assert.equal(result.uploaded, 2, 'index.php changed and New.php is new; .env is unchanged');
  assert.equal(result.removed, 2, 'old.css and Old.php are gone; storage/app/.gitignore is excluded now');
  assert.deepEqual(production(env), {
    '.env': 'APP_URL=https://www.example.com\nAPP_KEY=base64:key',
    'app/New.php': 'new',
    'public/index.php': 'v2',
    'public/uploads/photo.jpg': 'jpg',
    'storage/app/.gitignore': '*',
    'storage/logs/laravel.log': 'log',
  });
  assert.equal(fs.existsSync(path.join(env.server, 'my-site', 'production', 'app', 'Old.php')), false);
  assert.deepEqual(
    hooks.runs.map((r) => r.commands),
    [['php artisan down'], ['php artisan migrate --force', 'php artisan up']],
  );
  assert.equal(manifest(env).commit, 'c2');
  assert.match(log.text(), /Last deploy: commit c1/);
});

test('a dry run changes nothing', async () => {
  const env = setup();
  const { result, hooks } = await run(env, { 'index.html': 'x' }, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.uploaded, 2);
  assert.deepEqual(readTree(env.server), {});
  assert.deepEqual(hooks.runs, []);
});

test('nothing is uploaded when a command before the upload fails', async () => {
  const env = setup();
  await run(env, { 'public/index.php': 'v1' });
  const hooks = new FakeHooks({ failOn: 'php artisan down' });
  await assert.rejects(run(env, { 'public/index.php': 'v2' }, { hooks }), /command failed/);
  assert.equal(production(env)['public/index.php'], 'v1');
  assert.equal(manifest(env).commit, 'c1');
});

test('deploy.force: bootstrap uses the bootstrap block on a later deploy', async () => {
  const env = setup(makeConfig({ deploy: { force: 'bootstrap', bootstrap: { 'post-deployment-remote-commands': ['echo first'] } } }));
  await run(env, { 'index.html': 'v1' });
  const { result, hooks } = await run(env, { 'index.html': 'v2' });
  assert.equal(result.mode, 'bootstrap');
  assert.deepEqual(hooks.runs[0].commands, ['echo first']);
});

test('an empty build is refused', async () => {
  const env = setup();
  env.templates = tempDir();
  await assert.rejects(run(env, {}), /no files to deploy/);
});

test('missing template values are reported', async () => {
  const env = setup();
  writeFiles(env.templates, { 'extra.txt.template': '$NOT_SET' });
  const { log } = await run(env, { 'index.html': 'x' });
  assert.match(log.text(), /no value .*: NOT_SET/);
});

test('a damaged manifest counts as a first deploy and removes nothing', async () => {
  const env = setup();
  writeFiles(env.server, { 'my-site/.gitnow/production.json': '{oops', 'my-site/production/keep.txt': 'x' });
  const { result, log } = await run(env, { 'index.html': 'x' });
  assert.equal(result.mode, 'bootstrap');
  assert.equal(production(env)['keep.txt'], 'x');
  assert.match(log.text(), /is damaged/);
});
