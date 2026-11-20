'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../lib/config');
const { makeConfig } = require('./helpers');

const minimal = {
  version: '1.0',
  gitnow: { environments: { production: { domain: 'www.example.com' } } },
};

test('a minimal config gets sensible defaults', () => {
  const config = parseConfig(minimal);
  assert.equal(config.basePath, '/');
  assert.equal(config.webRoot, '');
  assert.equal(config.publishDir, './');
  assert.equal(config.transport, 'ftps');
  assert.deepEqual(config.production, { branch: 'main', domain: 'www.example.com', url: 'https://www.example.com', path: 'production' });
  assert.equal(config.previews.enabled, false);
  assert.deepEqual(config.deploy.bootstrap, { excludes: [], pre: [], post: [] });
  assert.equal(config.deploy.force, null);
});

test('IONOS deploy blocks are read as they are', () => {
  const config = makeConfig({
    deploy: {
      force: 'bootstrap',
      recurring: {
        excludes: ['storage', 'var'],
        'pre-deployment-remote-commands': ['php artisan down'],
        'post-deployment-remote-commands': 'php artisan up',
      },
    },
  });
  assert.equal(config.deploy.force, 'bootstrap');
  assert.deepEqual(config.deploy.recurring, { excludes: ['storage', 'var'], pre: ['php artisan down'], post: ['php artisan up'] });
});

test('version 1.0 is required; YAML may turn it into the number 1', () => {
  assert.doesNotThrow(() => parseConfig({ ...minimal, version: 1 }));
  assert.throws(() => parseConfig({ ...minimal, version: 2 }), /version/);
});

test('an IONOS config without the gitnow section explains what is missing', () => {
  assert.throws(() => parseConfig({ version: '1.0', deploy: {} }), /"gitnow:" section is missing/);
});

test('all problems are listed together', () => {
  assert.throws(
    () => parseConfig({ version: '1.0', gitnow: { transport: 'ssh', 'base-path': '../up', environments: { production: {} } } }),
    (error) => {
      assert.match(error.message, /ssh" is not available yet/);
      assert.match(error.message, /base-path" may not contain/);
      assert.match(error.message, /production.domain/);
      return true;
    },
  );
});

test('paths are normalized', () => {
  const config = makeConfig({ gitnow: { 'base-path': 'sites//shop/', 'web-root': '/public/' } });
  assert.equal(config.basePath, '/sites/shop');
  assert.equal(config.webRoot, 'public');
});

test('previews need a domain', () => {
  assert.throws(() => makeConfig({ environments: { previews: { enabled: true } } }), /previews.domain/);
  const config = makeConfig({ environments: { previews: { enabled: true, domain: 'preview.example.com' } } });
  assert.equal(config.previews.domain, 'preview.example.com');
});

test('a preview url template must contain {slug}', () => {
  assert.throws(() => makeConfig({ environments: { previews: { enabled: true, url: 'https://preview.example.com' } } }), /\{slug\}/);
});

test('bad domains and lists are reported', () => {
  assert.throws(() => makeConfig({ environments: { production: { domain: 'not a domain' } } }), /not a valid domain/);
  assert.throws(() => makeConfig({ deploy: { bootstrap: { excludes: { a: 1 } } } }), /excludes" must be a list/);
});

test('cron jobs are accepted with a warning', () => {
  const config = parseConfig({ ...minimal, runtime: { 'cron-jobs': [{ command: 'php x', schedule: '* * * * *' }] } });
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /cron-jobs is not supported yet/);
});
