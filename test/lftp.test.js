'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { LftpTransport, quote } = require('../lib/lftp');
const { silentLog } = require('./helpers');

function transport(runner, options = {}) {
  return new LftpTransport({ host: 'w0123456.kasserver.com', user: 'f0123456', password: 'pa"ss,word', log: silentLog(), runner, ...options });
}

test('values are quoted for lftp', () => {
  assert.equal(quote('a b'), '"a b"');
  assert.equal(quote('say "hi" \\o/'), '"say \\"hi\\" \\\\o/"');
  assert.throws(() => quote('bad\nname'), /line break/);
});

test('the connection forces TLS and never contains the password', async () => {
  let script = [];
  await transport(async (lines) => {
    script = lines;
    return { status: 0, output: '' };
  }).deleteFile('/x');
  const text = script.join('\n');
  assert.match(text, /set ftp:ssl-force yes/);
  assert.match(text, /set ftp:ssl-protect-data yes/);
  assert.match(text, /set ssl:verify-certificate yes/);
  assert.match(text, /open -p 21 -u "f0123456" --env-password "w0123456.kasserver.com"/);
  assert.doesNotMatch(text, /pa"ss/);
});

test('a host given as a URL is cleaned up', () => {
  assert.equal(transport(null, { host: 'ftps://w0123456.kasserver.com/' }).host, 'w0123456.kasserver.com');
});

test('certificate checks can be turned off', () => {
  assert.ok(transport(null, { verifyCertificate: false }).preamble().includes('set ssl:verify-certificate no'));
});

test('uploads are batched, and names with wildcard characters are sent one by one', () => {
  const files = Array.from({ length: 150 }, (_, i) => `f${i}.txt`).concat(['img/[1].png', 'a*b.txt']);
  const lines = transport(null).uploadScript('/tmp/site', '/my-site/production', files);
  assert.ok(lines.includes('lcd "/tmp/site"'));
  assert.ok(lines.includes('cd "/my-site/production"'));
  const mputs = lines.filter((line) => line.startsWith('mput -d -P 4 '));
  assert.equal(mputs.length, 2);
  assert.ok(mputs[1].endsWith('"f149.txt"'));
  assert.ok(lines.includes('mkdir -p -f "img"'));
  assert.ok(lines.includes('put "img/[1].png" -o "img/[1].png"'));
  assert.ok(lines.includes('put "a*b.txt" -o "a*b.txt"'));
});

test('a missing remote file reads as null', async () => {
  const t = transport(async (lines) => {
    const last = lines[lines.length - 1];
    if (last.startsWith('get ')) return { status: 1, output: 'get: Access failed: 550 No such file' };
    return { status: 0, output: 'production\n' };
  });
  assert.equal(await t.readFile('/my-site/.gitnow/production.json'), null);
});

test('a failed connection is not mistaken for a missing file', async () => {
  const t = transport(async () => ({ status: 1, output: 'Login failed: 530 Login incorrect.' }));
  await assert.rejects(t.readFile('/x.json'), /Could not connect to the FTP server.*\n.*Login incorrect/);
});

test('an existing remote file is read', async () => {
  const t = transport(async (lines) => {
    const target = /-o "(.+)"$/.exec(lines[lines.length - 1])[1].replace(/\\\\/g, '\\');
    fs.writeFileSync(target, '{"files":{}}');
    return { status: 0, output: '' };
  });
  assert.equal(await t.readFile('/x.json'), '{"files":{}}');
});

test('failed transfers report lftp output', async () => {
  const t = transport(async () => ({ status: 1, output: 'put: Access failed: 553 Permission denied' }));
  await assert.rejects(t.upload('/tmp', '/site', ['a.txt']), /FTP transfer failed:\nput: Access failed/);
});
