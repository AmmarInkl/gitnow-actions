'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEnvironment, slugify } = require('../lib/resolve');
const { makeConfig } = require('./helpers');

const withPreviews = (previews = {}) =>
  makeConfig({ environments: { previews: { enabled: true, domain: 'preview.example.com', ...previews } } });

test('the production branch deploys to production', () => {
  const result = resolveEnvironment(makeConfig(), 'main');
  assert.equal(result.enabled, true);
  assert.equal(result.environment, 'production');
  assert.equal(result.siteUrl, 'https://www.example.com');
  assert.equal(result.targetPath, '/my-site/production');
});

test('other branches are skipped while previews are off', () => {
  const result = resolveEnvironment(makeConfig(), 'feature/x');
  assert.equal(result.enabled, false);
  assert.match(result.reason, /preview sites are turned off/);
});

test('other branches get a preview site', () => {
  const result = resolveEnvironment(withPreviews(), 'feature/New Header');
  assert.equal(result.enabled, true);
  assert.equal(result.kind, 'preview');
  assert.equal(result.environment, 'preview-feature-new-header');
  assert.equal(result.siteUrl, 'https://feature-new-header.preview.example.com');
  assert.equal(result.targetPath, '/my-site/previews/feature-new-header');
});

test('a preview address can follow a pattern', () => {
  const result = resolveEnvironment(withPreviews({ url: 'https://example.com/previews/{slug}' }), 'fix-1');
  assert.equal(result.siteUrl, 'https://example.com/previews/fix-1');
});

test('excluded branches get no preview', () => {
  const config = withPreviews({ 'exclude-branches': ['dependabot/**', 'tmp-*'] });
  assert.equal(resolveEnvironment(config, 'dependabot/npm/lodash-4').enabled, false);
  assert.equal(resolveEnvironment(config, 'tmp-test').enabled, false);
  assert.equal(resolveEnvironment(config, 'tmp/test').enabled, true);
});

test('branch names become valid subdomain labels', () => {
  assert.equal(slugify('Feature/ÄÖÜ--Test_1'), 'feature-test-1');
  assert.match(slugify('---'), /^branch-[0-9a-f]{6}$/);
  const long = slugify('feature/' + 'a'.repeat(80));
  assert.ok(long.length <= 40, long);
  assert.match(long, /-[0-9a-f]{6}$/);
  assert.equal(slugify('feature/' + 'a'.repeat(80)), long, 'the same branch always gets the same slug');
  assert.notEqual(slugify('feature/' + 'a'.repeat(80)), slugify('feature/' + 'a'.repeat(81)));
});

test('an empty branch is not deployed', () => {
  assert.equal(resolveEnvironment(makeConfig(), '').enabled, false);
});
