'use strict';

// Runs commands like "php artisan migrate" without SSH: GitNow uploads a one-time PHP
// script (php/hook.php) into the site, calls it over HTTPS with a secret token, and
// the script runs the commands written into it, streams their output, and deletes itself.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UserError } = require('./gha');
const { joinRemote } = require('./paths');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'php', 'hook.php'), 'utf8');
const RESULT_LINE = /^\[gitnow\] result: (ok|failed)$/;

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** The PHP source for one hook. Only base64, hex and ".." paths are written into the PHP code. */
function buildHook({ commands, token, webRoot = '', phpCli = '', createdAt = Math.floor(Date.now() / 1000) }) {
  const depth = webRoot.split('/').filter(Boolean).length;
  const values = {
    __TOKEN_HASH__: crypto.createHash('sha256').update(token).digest('hex'),
    __CREATED_AT__: String(Math.floor(createdAt)),
    __COMMANDS__: base64(JSON.stringify(commands)),
    __APP_ROOT__: depth === 0 ? '.' : Array(depth).fill('..').join('/'),
    __PHP_CLI__: base64(phpCli),
  };
  return TEMPLATE.replace(/__[A-Z_]+__/g, (match) => values[match] ?? match);
}

function hookFileName() {
  return `.gitnow-hook-${crypto.randomBytes(12).toString('hex')}.php`;
}

/** Call the hook, print its output as it arrives, and report whether all commands succeeded. */
async function callHook(url, token, log, { timeoutMs = 30 * 60 * 1000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'X-GitNow-Token': token, 'User-Agent': 'GitNow' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw new UserError(`Could not reach ${url}: ${error.cause?.message || error.message}. Check the domain and its SSL certificate.`);
    }

    if (response.status === 404) {
      throw new UserError(
        `The deploy hook was not found at ${url}. The domain must point at the deploy folder` +
          ' (plus "web-root" from config.yaml), and the site address in config.yaml must match it.',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UserError(
        `${url} redirects to ${response.headers.get('location')}. Use that address as the site address in config.yaml.`,
      );
    }
    if (!response.ok || !response.body) {
      throw new UserError(`The deploy hook at ${url} answered with HTTP ${response.status}.`);
    }

    let result = null;
    let buffer = '';
    const decoder = new TextDecoder();
    const handleLine = (line) => {
      const match = RESULT_LINE.exec(line.trim());
      if (match) result = match[1];
      else log.info(line);
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer !== '') handleLine(buffer);

    return { ok: result === 'ok', finished: result !== null };
  } finally {
    clearTimeout(timer);
  }
}

class HookRunner {
  constructor({ transport, targetPath, webRoot, siteUrl, phpCli = '', log, fetchImpl }) {
    Object.assign(this, { transport, targetPath, webRoot, siteUrl, phpCli, log, fetchImpl });
  }

  async run(commands, title) {
    if (commands.length === 0) return;
    await this.log.group(title, async () => {
      const token = crypto.randomBytes(32).toString('hex');
      const name = hookFileName();
      const remotePath = joinRemote(this.targetPath, this.webRoot, name);
      const url = `${this.siteUrl.replace(/\/+$/, '')}/${name}`;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnow-hook-'));
      const local = path.join(dir, name);
      fs.writeFileSync(local, buildHook({ commands, token, webRoot: this.webRoot, phpCli: this.phpCli }));

      try {
        await this.transport.putFile(local, remotePath);
        const result = await callHook(url, token, this.log, { fetchImpl: this.fetchImpl });
        if (!result.ok) {
          throw new UserError(
            result.finished
              ? 'A command failed. Its output is above.'
              : 'The commands did not finish: the connection to the hook ended early. Check the PHP error log of the domain (in KAS under "Logs").',
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        // The hook deletes itself; this also covers a hook that was never called.
        await this.transport.deleteFile(remotePath).catch(() => {});
      }
    });
  }
}

module.exports = { buildHook, hookFileName, callHook, HookRunner };
