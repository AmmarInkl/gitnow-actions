'use strict';

const gha = require('../lib/gha');
const { loadProject } = require('../lib/project');

gha.run(async () => {
  const { config, branch, resolved } = loadProject(gha.getInput('project', { required: true }), {
    branch: gha.getInput('branch'),
    log: gha.log,
  });

  gha.setOutput('enabled', resolved.enabled ? 'true' : 'false');
  gha.setOutput('reason', resolved.reason);
  gha.setOutput('environment', resolved.environment);
  gha.setOutput('kind', resolved.kind);
  gha.setOutput('site-url', resolved.siteUrl);
  gha.setOutput('target-path', resolved.targetPath);
  gha.setOutput('publish-dir', config.publishDir);

  if (resolved.enabled) {
    gha.log.info(`Branch "${branch}" deploys to ${resolved.environment}: ${resolved.siteUrl}`);
    gha.log.info(`FTP folder: ${resolved.targetPath}`);
  } else {
    gha.log.notice(resolved.reason);
  }
});
