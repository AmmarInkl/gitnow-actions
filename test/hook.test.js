'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildHook, callHook, hookFileName, HookRunner } = require('../lib/hook');
const { tempDir, cleanUp, silentLog, LocalTransport } = require('./helpers');

test.after(cleanUp);

const decode = (source, name) => {
  const match = new RegExp(`const ${name} = '([^']*)';`).exec(source);
  return Buffer.from(match[1], 'base64').toString('utf8');
};

test('the hook holds a hash of the token, never the token', () => {
  const source = buildHook({ commands: ['php artisan migrate --force'], token: 'secret-token', webRoot: 'public', createdAt: 1700000000 });
  assert.doesNotMatch(source, /secret-token/);
  assert.match(source, new RegExp(crypto.createHash('sha256').update('secret-token').digest('hex')));
  assert.match(source, /const GITNOW_CREATED_AT = 1700000000;/);
  assert.match(source, /const GITNOW_APP_ROOT = '\.\.';/);
  assert.deepEqual(JSON.parse(decode(source, 'GITNOW_COMMANDS')), ['php artisan migrate --force']);
  assert.doesNotMatch(source, /__[A-Z_]+__(?<!__FILE__|__DIR__)/);
});

test('the app folder is found from the web root', () => {
  assert.match(buildHook({ commands: [], token: 't' }), /GITNOW_APP_ROOT = '\.'/);
  assert.match(buildHook({ commands: [], token: 't', webRoot: 'web/public' }), /GITNOW_APP_ROOT = '\.\.\/\.\.'/);
});

test('commands with quotes cannot break out of the PHP code', () => {
  const nasty = ["php -r 'echo 1;'; ' . system('x') . '", '\\\'"'];
  const source = buildHook({ commands: nasty, token: 't', phpCli: "/usr/bin/php'8" });
  assert.deepEqual(JSON.parse(decode(source, 'GITNOW_COMMANDS')), nasty);
  assert.equal(decode(source, 'GITNOW_PHP_CLI'), "/usr/bin/php'8");
});

test('hook file names are random and hidden', () => {
  assert.match(hookFileName(), /^\.gitnow-hook-[0-9a-f]{24}\.php$/);
  assert.notEqual(hookFileName(), hookFileName());
});

const fakeFetch = (body, init = { status: 200 }) => async () => new Response(body, init);

test('hook output is shown and the result line is read', async () => {
  const log = silentLog();
  const result = await callHook('https://x.test/h.php', 't', log, {
    fetchImpl: fakeFetch('[gitnow] $ php artisan up\nApplication is now live.\n[gitnow] exit code 0\n[gitnow] result: ok\n'),
  });
  assert.deepEqual(result, { ok: true, finished: true });
  assert.match(log.text(), /Application is now live/);
  assert.doesNotMatch(log.text(), /result:/);
});

test('a failed command, a cut connection, a missing hook and a redirect are reported', async () => {
  const log = silentLog();
  assert.deepEqual(await callHook('u', 't', log, { fetchImpl: fakeFetch('[gitnow] result: failed\n') }), { ok: false, finished: true });
  assert.deepEqual(await callHook('u', 't', log, { fetchImpl: fakeFetch('partial output') }), { ok: false, finished: false });
  await assert.rejects(callHook('u', 't', log, { fetchImpl: fakeFetch('', { status: 404 }) }), /hook was not found/);
  await assert.rejects(
    callHook('u', 't', log, { fetchImpl: fakeFetch(null, { status: 301, headers: { location: 'https://www.x.test/' } }) }),
    /redirects to https:\/\/www.x.test\//,
  );
  await assert.rejects(
    callHook('u', 't', log, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    /Could not reach u/,
  );
});

test('the hook runner uploads the hook, calls it and always removes it', async () => {
  const server = tempDir();
  const transport = new LocalTransport(server);
  let calledUrl = '';
  const runner = new HookRunner({
    transport,
    targetPath: '/site/production',
    webRoot: 'public',
    siteUrl: 'https://www.example.com/',
    log: silentLog(),
    fetchImpl: async (url) => {
      calledUrl = url;
      const name = url.split('/').pop();
      assert.ok(fs.existsSync(path.join(server, 'site', 'production', 'public', name)), 'the hook is uploaded into the web root');
      return new Response('[gitnow] result: failed\n');
    },
  });
  await assert.rejects(runner.run(['php artisan up'], 'After'), /A command failed/);
  assert.match(calledUrl, /^https:\/\/www\.example\.com\/\.gitnow-hook-[0-9a-f]{24}\.php$/);
  assert.deepEqual(fs.readdirSync(path.join(server, 'site', 'production', 'public')), [], 'the hook is removed');
});

// ---------------------------------------------------------------- with real PHP

const php = spawnSync('php', ['-v']).error ? null : 'php';

async function withPhpServer(docroot, callback) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(php, ['-d', 'xdebug.mode=off', '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.kill();
  }
}

test('the generated PHP is valid and runs commands with real PHP', { skip: php ? false : 'php is not installed' }, async () => {
  const docroot = tempDir();
  const write = (name, options) => {
    const file = path.join(docroot, name);
    fs.writeFileSync(file, buildHook({ token: 'good-token', ...options }));
    return file;
  };

  const lint = spawnSync(php, ['-l', write('lint.php', { commands: ['php -v'] })], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);

  await withPhpServer(docroot, async (base) => {
    // Wrong token: looks like a missing page, and the hook stays.
    const okFile = write('ok.php', { commands: ['php -v'] });
    await assert.rejects(callHook(`${base}/ok.php`, 'bad-token', silentLog()), /not found/);
    assert.ok(fs.existsSync(okFile));

    // Right token: runs, shows the output, deletes itself.
    const log = silentLog();
    assert.deepEqual(await callHook(`${base}/ok.php`, 'good-token', log), { ok: true, finished: true });
    assert.match(log.text(), /PHP \d+\.\d+/);
    assert.equal(fs.existsSync(okFile), false, 'the hook deletes itself');

    // A failing command stops the run.
    write('fail.php', { commands: ['php -r exit(3);', 'php -v'] });
    const failLog = silentLog();
    assert.deepEqual(await callHook(`${base}/fail.php`, 'good-token', failLog), { ok: false, finished: true });
    assert.match(failLog.text(), /exit code 3/);
    assert.doesNotMatch(failLog.text(), /PHP \d+\.\d+\.\d+ \(cli/);

    // An old hook refuses to run.
    write('old.php', { commands: ['php -v'], createdAt: Math.floor(Date.now() / 1000) - 3600 });
    const oldLog = silentLog();
    await assert.rejects(callHook(`${base}/old.php`, 'good-token', oldLog), /HTTP 410/);
  });
});
