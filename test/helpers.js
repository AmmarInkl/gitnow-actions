'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConfig } = require('../lib/config');

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnow-test-'));
  tempDirs.push(dir);
  return dir;
}

function cleanUp() {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function readTree(root) {
  const files = {};
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else files[childRel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    }
  };
  walk(root, '');
  return files;
}

/** A logger that records messages instead of printing them. */
function silentLog() {
  const messages = [];
  const add = (level) => (message) => messages.push({ level, message });
  return {
    messages,
    info: add('info'),
    notice: add('notice'),
    warning: add('warning'),
    error: add('error'),
    async group(title, callback) {
      messages.push({ level: 'group', message: title });
      return callback();
    },
    text: () => messages.map((m) => m.message).join('\n'),
  };
}

/** Stands in for the FTP server: "remote" paths are folders under serverDir. */
class LocalTransport {
  constructor(serverDir) {
    this.serverDir = serverDir;
  }

  local(remotePath) {
    return path.join(this.serverDir, ...remotePath.split('/').filter(Boolean));
  }

  async readFile(remotePath) {
    const file = this.local(remotePath);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  async upload(localRoot, remoteRoot, files) {
    for (const file of files) {
      const target = this.local(`${remoteRoot}/${file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(localRoot, file), target);
    }
  }

  async remove(remoteRoot, files) {
    for (const file of files) fs.rmSync(this.local(`${remoteRoot}/${file}`), { force: true });
  }

  async removeFolders(remoteRoot, folders) {
    for (const folder of folders) {
      try {
        fs.rmdirSync(this.local(`${remoteRoot}/${folder}`));
      } catch {
        // not empty: keep it, like rmdir on the FTP server
      }
    }
  }

  async putFile(localFile, remotePath) {
    const target = this.local(remotePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(localFile, target);
  }

  async deleteFile(remotePath) {
    fs.rmSync(this.local(remotePath), { force: true });
  }
}

/** Records hook runs instead of calling a server. */
class FakeHooks {
  constructor({ failOn } = {}) {
    this.runs = [];
    this.failOn = failOn;
  }

  async run(commands, title) {
    if (commands.length === 0) return;
    this.runs.push({ commands, title });
    if (this.failOn && commands.includes(this.failOn)) throw new Error(`command failed: ${this.failOn}`);
  }
}

/** A valid config; pass changes to the raw YAML structure. */
function makeConfig({ deploy = {}, gitnow = {}, environments = {} } = {}) {
  return parseConfig({
    version: 1.0,
    deploy,
    gitnow: {
      'base-path': '/my-site',
      ...gitnow,
      environments: {
        production: { branch: 'main', domain: 'www.example.com' },
        ...environments,
      },
    },
  });
}

module.exports = { tempDir, cleanUp, writeFiles, readTree, silentLog, LocalTransport, FakeHooks, makeConfig };
