'use strict';

// One deploy, start to finish:
//   1. read the manifest of the last deploy → first deploy (bootstrap) or a later one (recurring)
//   2. render templates (.env.template → .env) into the site
//   3. hash the site and compare with the manifest → files to upload and to remove
//   4. commands before the upload (through the hook)
//   5. upload changed files, remove files that are gone
//   6. save the new manifest
//   7. commands after the upload (through the hook)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BUILT_IN_EXCLUDES } = require('./config');
const { compileExcludes } = require('./excludes');
const { UserError } = require('./gha');
const { hashTree, diffFiles } = require('./manifest');
const { joinRemote } = require('./paths');
const { renderTemplates } = require('./templates');

const LIST_LIMIT = 200;

function manifestPath(config, resolved) {
  return joinRemote(config.basePath, '.gitnow', `${resolved.environment}.json`);
}

function listFiles(log, title, files) {
  if (files.length === 0) return;
  log.info(`${title}:`);
  for (const file of files.slice(0, LIST_LIMIT)) log.info(`  ${file}`);
  if (files.length > LIST_LIMIT) log.info(`  … and ${files.length - LIST_LIMIT} more`);
}

/**
 * @param {object} options
 * @param {object} options.config      From parseConfig().
 * @param {object} options.resolved    From resolveEnvironment().
 * @param {string} options.siteDir     The built site (the extracted artifact). Templates are written into it.
 * @param {string} options.templateDir .deploy-now/<project>
 * @param {object} options.templateValues From templateValues().
 * @param {object} options.transport   LftpTransport, or a fake in tests.
 * @param {object} options.hooks       HookRunner, or a fake in tests.
 * @param {object} options.meta        {project, branch, commit, runUrl}
 */
async function deploy({ config, resolved, siteDir, templateDir, templateValues, transport, hooks, meta, dryRun = false, log }) {
  const remoteManifest = manifestPath(config, resolved);

  const previous = await log.group('Reading the last deploy', async () => {
    const content = await transport.readFile(remoteManifest);
    if (content === null) {
      log.info('No earlier GitNow deploy found, so this is the first one (bootstrap).');
      return null;
    }
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.files === 'object' && parsed.files !== null) {
        log.info(`Last deploy: commit ${parsed.commit || 'unknown'} at ${parsed.deployed_at || 'an unknown time'}.`);
        return parsed;
      }
    } catch {
      // handled below
    }
    log.warning(`${remoteManifest} is damaged, so this deploy counts as a first deploy and removes no old files.`);
    return null;
  });

  const mode = config.deploy.force || (previous ? 'recurring' : 'bootstrap');
  const block = config.deploy[mode];
  const isExcluded = compileExcludes([...BUILT_IN_EXCLUDES, ...block.excludes]);
  log.info(`Deploy mode: ${mode}${config.deploy.force ? ' (set by deploy.force)' : ''}`);

  const rendered = renderTemplates(templateDir, siteDir, templateValues);
  if (rendered.files.length > 0) {
    log.info(`Rendered templates: ${rendered.files.join(', ')}`);
  }
  if (rendered.unknown.length > 0) {
    log.warning(
      `These template variables have no value and were left as they are: ${rendered.unknown.join(', ')}. ` +
        'Add them as GitHub secrets or variables.',
    );
  }

  const files = await hashTree(siteDir, isExcluded, log);
  const fileCount = Object.keys(files).length;
  if (fileCount === 0) {
    throw new UserError('There are no files to deploy. Check "publish-dir" in config.yaml and the build steps.');
  }
  const changes = diffFiles(previous ? previous.files : {}, files, isExcluded);
  log.info(`${fileCount} files: ${changes.upload.length} to upload, ${changes.unchanged} unchanged, ${changes.remove.length} to remove.`);

  await log.group('Planned changes', async () => {
    listFiles(log, 'Upload', changes.upload);
    listFiles(log, 'Remove', changes.remove);
    if (changes.upload.length === 0 && changes.remove.length === 0) log.info('Nothing changed.');
  });

  const result = {
    mode,
    files: fileCount,
    uploaded: changes.upload.length,
    removed: changes.remove.length,
    unchanged: changes.unchanged,
    manifestPath: remoteManifest,
    dryRun,
  };
  if (dryRun) {
    log.notice('Dry run: nothing was changed on the server.');
    return result;
  }

  await hooks.run(block.pre, 'Commands before the upload');

  if (changes.upload.length > 0) {
    await log.group(`Uploading ${changes.upload.length} files to ${resolved.targetPath}`, () =>
      transport.upload(siteDir, resolved.targetPath, changes.upload),
    );
  }
  if (changes.remove.length > 0) {
    await log.group(`Removing ${changes.remove.length} old files`, async () => {
      await transport.remove(resolved.targetPath, changes.remove);
      await transport.removeFolders(resolved.targetPath, changes.removedFolders);
    });
  }

  // Saved before the "after" commands: the files are on the server now, whatever the commands do.
  const manifest = {
    gitnow: 1,
    project: meta.project,
    environment: resolved.environment,
    branch: meta.branch,
    commit: meta.commit,
    run_url: meta.runUrl,
    mode,
    deployed_at: new Date().toISOString(),
    target: resolved.targetPath,
    files,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnow-manifest-'));
  try {
    const local = path.join(dir, 'manifest.json');
    fs.writeFileSync(local, JSON.stringify(manifest));
    await transport.putFile(local, remoteManifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await hooks.run(block.post, 'Commands after the upload');
  return result;
}

module.exports = { deploy, manifestPath };
