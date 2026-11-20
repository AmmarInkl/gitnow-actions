'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gha = require('../lib/gha');
const { deploy } = require('../lib/deploy');
const { HookRunner } = require('../lib/hook');
const { LftpTransport, ensureLftp } = require('../lib/lftp');
const { loadProject } = require('../lib/project');
const { templateValues } = require('../lib/templates');

const { UserError } = gha;

/** Unpack the build artifact (or copy a folder) into an empty folder. */
function prepareSite(artifact) {
  if (!fs.existsSync(artifact)) {
    throw new UserError(`The build artifact was not found at ${artifact}.`);
  }
  const siteDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gitnow-site-'));
  if (fs.statSync(artifact).isDirectory()) {
    fs.cpSync(artifact, siteDir, { recursive: true });
  } else {
    const result = spawnSync('tar', ['-xzf', artifact, '-C', siteDir], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new UserError(`Could not unpack ${artifact}:\n${result.stderr}`);
    }
  }
  return siteDir;
}

function summary(project, branch, resolved, result) {
  const rows = [
    ['Site', resolved.siteUrl],
    ['Branch', branch],
    ['FTP folder', resolved.targetPath],
    ['Deploy', result.mode === 'bootstrap' ? 'first deploy (bootstrap)' : 'update (recurring)'],
    ['Uploaded', `${result.uploaded} of ${result.files} files`],
    ['Removed', `${result.removed} files`],
  ];
  return [
    `### GitNow: ${project} → ${resolved.environment}${result.dryRun ? ' (dry run)' : ''}`,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([label, value]) => `| ${label} | ${String(value).replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
}

gha.run(async () => {
  const project = gha.getInput('project', { required: true });
  const { projectDir, config, branch, resolved } = loadProject(project, { branch: gha.getInput('branch'), log: gha.log });
  if (!resolved.enabled) {
    throw new UserError(resolved.reason);
  }

  const password = gha.getInput('ftp-password', { required: true });
  gha.mask(password);
  const port = Number(gha.getInput('ftp-port') || '21');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError('"ftp-port" must be a port number.');
  }

  const siteDir = prepareSite(gha.getInput('artifact', { required: true }));
  const dryRun = gha.getBooleanInput('dry-run', false);
  ensureLftp(gha.log);

  const transport = new LftpTransport({
    host: gha.getInput('ftp-host', { required: true }),
    port,
    user: gha.getInput('ftp-user', { required: true }),
    password,
    verifyCertificate: gha.getBooleanInput('verify-certificate', true),
    log: gha.log,
  });
  const hooks = new HookRunner({
    transport,
    targetPath: resolved.targetPath,
    webRoot: config.webRoot,
    siteUrl: resolved.siteUrl,
    phpCli: config.phpCli,
    log: gha.log,
  });

  const commit = process.env.GITHUB_SHA || '';
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';

  const result = await deploy({
    config,
    resolved,
    siteDir,
    templateDir: projectDir,
    templateValues: templateValues({
      siteUrl: resolved.siteUrl,
      environment: resolved.environment,
      branch,
      commit,
      secrets: gha.getJsonInput('secrets'),
      variables: gha.getJsonInput('variables'),
    }),
    transport,
    hooks,
    meta: { project, branch, commit, runUrl },
    dryRun,
    log: gha.log,
  });

  gha.setOutput('site-url', resolved.siteUrl);
  gha.setOutput('mode', result.mode);
  gha.setOutput('uploaded', result.uploaded);
  gha.setOutput('removed', result.removed);
  gha.addSummary(summary(project, branch, resolved, result));
  gha.log.info(dryRun ? 'Dry run finished.' : `Deployed to ${resolved.siteUrl}`);
});
