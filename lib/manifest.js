'use strict';

// The deploy manifest lists every file GitNow uploaded, with its SHA-256 hash.
// It is stored on the server, outside the site, in <base-path>/.gitnow/<environment>.json.
// Comparing hashes (not dates) means only changed files are uploaded, even though
// every GitHub checkout gives all files a new date.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Hash every file under root that isn't excluded. Keys are paths like "css/site.css". */
async function hashTree(root, isExcluded, log) {
  const files = {};
  async function walk(dir, relative) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(rel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        log.warning(`Skipped ${rel}: it is a symbolic link, and FTP can't create those.`);
      } else if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        files[rel] = await sha256File(full);
      }
    }
  }
  await walk(root, '');
  return files;
}

function parentFolders(paths) {
  const folders = new Set();
  for (const file of paths) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return folders;
}

/**
 * Compare the last deploy with this one.
 * Files are only removed if GitNow deployed them before and they aren't excluded now,
 * so files the app creates on the server (uploads, cache, logs) are never touched.
 */
function diffFiles(previous, current, isExcluded) {
  const upload = [];
  const remove = [];
  let unchanged = 0;

  for (const [file, hash] of Object.entries(current)) {
    if (Object.hasOwn(previous, file) && previous[file] === hash) unchanged++;
    else upload.push(file);
  }
  for (const file of Object.keys(previous)) {
    if (!Object.hasOwn(current, file) && !isExcluded(file)) remove.push(file);
  }

  // Folders that only held removed files; deepest first so they can be removed in order.
  const stillUsed = parentFolders(Object.keys(current));
  const removedFolders = [...parentFolders(remove)]
    .filter((folder) => !stillUsed.has(folder) && !isExcluded(folder))
    .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1));

  return { upload: upload.sort(), remove: remove.sort(), unchanged, removedFolders };
}

module.exports = { sha256File, hashTree, diffFiles };
