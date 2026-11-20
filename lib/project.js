'use strict';

// Shared start of both actions: find and read the project's config.yaml, and work out the branch.

const path = require('node:path');
const { UserError } = require('./gha');
const { loadConfig } = require('./config');
const { resolveEnvironment } = require('./resolve');

function loadProject(project, { workspace = process.env.GITHUB_WORKSPACE || process.cwd(), branch, log }) {
  if (!/^[A-Za-z0-9._-]+$/.test(project) || project.startsWith('.')) {
    throw new UserError('"project" may only contain letters, digits, dots, dashes and underscores.');
  }
  const projectDir = path.join(workspace, '.deploy-now', project);
  const displayName = `.deploy-now/${project}/config.yaml`;
  const config = loadConfig(path.join(projectDir, 'config.yaml'), displayName);
  config.warnings.forEach((warning) => log.warning(warning));

  const branchName = branch || process.env.GITHUB_REF_NAME || '';
  const resolved = resolveEnvironment(config, branchName);
  return { projectDir, config, branch: branchName, resolved };
}

module.exports = { loadProject };
