'use strict';

// Talks to the all-inkl FTP server over FTPS (FTP with TLS) using lftp.
// Each operation writes a short lftp script and runs it. The password is passed in the
// LFTP_PASSWORD environment variable, never on the command line or in a file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { UserError } = require('./gha');

const BATCH_SIZE = 100;
const PARALLEL_UPLOADS = 4;

/** Quote a value for an lftp script. */
function quote(value) {
  const textValue = String(value);
  if (/[\r\n\0]/.test(textValue)) {
    throw new UserError(`Can't transfer a file whose name contains a line break: ${JSON.stringify(textValue)}`);
  }
  return `"${textValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** mput treats * ? [ as patterns, so such names are uploaded one by one with put. */
function hasGlobCharacters(name) {
  return /[*?[\]]/.test(name);
}

function parentOf(remotePath) {
  const index = remotePath.lastIndexOf('/');
  return index <= 0 ? '/' : remotePath.slice(0, index);
}

class LftpTransport {
  /**
   * @param {{host: string, port?: number, user: string, password: string, verifyCertificate?: boolean,
   *          log: object, runner?: (lines: string[]) => Promise<{status: number, output: string}>}} options
   *   runner replaces lftp in tests.
   */
  constructor({ host, port = 21, user, password, verifyCertificate = true, log, runner }) {
    this.host = host.replace(/^ftps?:\/\//i, '').replace(/\/.*$/, '');
    this.port = port;
    this.user = user;
    this.password = password;
    this.verifyCertificate = verifyCertificate;
    this.log = log;
    this.runner = runner || ((lines) => this.runLftp(lines));
  }

  preamble() {
    return [
      'set cmd:fail-exit yes',
      'set cmd:interactive no',
      'set net:max-retries 3',
      'set net:reconnect-interval-base 5',
      'set net:timeout 30',
      'set ftp:ssl-force yes',
      'set ftp:ssl-protect-data yes',
      'set ftp:ssl-protect-list yes',
      'set ftp:passive-mode yes',
      `set ssl:verify-certificate ${this.verifyCertificate ? 'yes' : 'no'}`,
      'set xfer:clobber yes',
      `open -p ${Number(this.port)} -u ${quote(this.user)} --env-password ${quote(this.host)}`,
    ];
  }

  async run(lines, { allowFailure = false } = {}) {
    const result = await this.runner([...this.preamble(), ...lines]);
    if (result.status !== 0 && !allowFailure) {
      throw new UserError(`The FTP transfer failed:\n${result.output.trim() || `lftp exited with code ${result.status}`}`);
    }
    return result;
  }

  // ---------------------------------------------------------------- operations

  /** @returns {Promise<string|null>} The file's content, or null when it doesn't exist. */
  async readFile(remotePath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnow-get-'));
    const local = path.join(dir, 'file');
    try {
      const result = await this.run([`get ${quote(remotePath)} -o ${quote(local)}`], { allowFailure: true });
      if (result.status === 0 && fs.existsSync(local)) {
        return fs.readFileSync(local, 'utf8');
      }
      // Missing file, or no connection at all? Listing the top folder tells them apart.
      const check = await this.run(['cls -1 /'], { allowFailure: true });
      if (check.status !== 0) {
        throw new UserError(`Could not connect to the FTP server ${this.host}:\n${check.output.trim()}`);
      }
      return null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  uploadScript(localRoot, remoteRoot, files) {
    const lines = [
      'set cmd:fail-exit no',
      `mkdir -p -f ${quote(remoteRoot)}`,
      'set cmd:fail-exit yes',
      `lcd ${quote(localRoot)}`,
      `cd ${quote(remoteRoot)}`,
    ];
    const normal = files.filter((file) => !hasGlobCharacters(file));
    const special = files.filter((file) => hasGlobCharacters(file));
    for (let i = 0; i < normal.length; i += BATCH_SIZE) {
      const batch = normal.slice(i, i + BATCH_SIZE);
      lines.push(`mput -d -P ${PARALLEL_UPLOADS} ${batch.map(quote).join(' ')}`);
    }
    for (const file of special) {
      if (file.includes('/')) {
        lines.push('set cmd:fail-exit no', `mkdir -p -f ${quote(parentOf('/' + file).slice(1))}`, 'set cmd:fail-exit yes');
      }
      lines.push(`put ${quote(file)} -o ${quote(file)}`);
    }
    return lines;
  }

  async upload(localRoot, remoteRoot, files) {
    if (files.length === 0) return;
    await this.run(this.uploadScript(localRoot, remoteRoot, files));
  }

  removeScript(remoteRoot, files) {
    // A file that is already gone is not an error.
    return ['set cmd:fail-exit no', `cd ${quote(remoteRoot)}`, ...files.map((file) => `rm -f ${quote(file)}`)];
  }

  async remove(remoteRoot, files) {
    if (files.length === 0) return;
    const result = await this.run(this.removeScript(remoteRoot, files), { allowFailure: true });
    if (result.status !== 0) {
      this.log.warning('Some old files could not be removed from the server. The output above shows which.');
    }
  }

  /** Remove now-empty folders. Folders that still hold files (e.g. made by the app) stay. */
  async removeFolders(remoteRoot, folders) {
    if (folders.length === 0) return;
    await this.run(['set cmd:fail-exit no', `cd ${quote(remoteRoot)}`, ...folders.map((folder) => `rmdir ${quote(folder)}`)], {
      allowFailure: true,
    });
  }

  putFileScript(localFile, remotePath) {
    return [
      'set cmd:fail-exit no',
      `mkdir -p -f ${quote(parentOf(remotePath))}`,
      'set cmd:fail-exit yes',
      `put ${quote(localFile)} -o ${quote(remotePath)}`,
    ];
  }

  async putFile(localFile, remotePath) {
    await this.run(this.putFileScript(localFile, remotePath));
  }

  async deleteFile(remotePath) {
    await this.run(['set cmd:fail-exit no', `rm -f ${quote(remotePath)}`], { allowFailure: true });
  }

  // ---------------------------------------------------------------- running lftp

  runLftp(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnow-lftp-'));
    const script = path.join(dir, 'script.lftp');
    fs.writeFileSync(script, lines.join('\n') + '\n', { mode: 0o600 });

    return new Promise((resolve, reject) => {
      const child = spawn('lftp', ['-f', script], {
        env: { ...process.env, LFTP_PASSWORD: this.password },
      });
      let output = '';
      const collect = (chunk) => {
        const textChunk = chunk.toString();
        output += textChunk;
        process.stdout.write(textChunk);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error) => {
        fs.rmSync(dir, { recursive: true, force: true });
        reject(error.code === 'ENOENT' ? new UserError('lftp is not installed on this runner.') : error);
      });
      child.on('close', (status) => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ status: status ?? 1, output });
      });
    });
  }
}

/** Install lftp on GitHub's Ubuntu runners if it isn't there yet. */
function ensureLftp(log) {
  if (!spawnSync('lftp', ['--version']).error) return;
  log.info('Installing lftp…');
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const install = () => spawnSync('sudo', ['apt-get', 'install', '-y', '-qq', 'lftp'], { env, encoding: 'utf8' });
  let result = install();
  if (result.status !== 0) {
    spawnSync('sudo', ['apt-get', 'update', '-qq'], { env });
    result = install();
  }
  if (result.status !== 0 || spawnSync('lftp', ['--version']).error) {
    throw new UserError(`Could not install lftp. Use a GitHub-hosted ubuntu-latest runner.\n${result.stderr || ''}`);
  }
}

module.exports = { LftpTransport, ensureLftp, quote };
