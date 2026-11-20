'use strict';

// Reads .deploy-now/<project>/config.yaml.
// The "deploy:" and "runtime:" parts are the same as IONOS Deploy Now's config.yaml.
// The "gitnow:" part says where on all-inkl to deploy.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { UserError } = require('./gha');
const { pathParts } = require('./paths');

/** Never uploaded and never deleted. */
const BUILT_IN_EXCLUDES = ['.git', '.github', '.deploy-now', '.gitnow-hook-*.php'];

/** Turn a YAML file into a plain object, using yq (preinstalled on GitHub's Ubuntu runners) or Python. */
function readYamlFile(file, displayName = file) {
  if (!fs.existsSync(file)) {
    throw new UserError(`Can't find ${displayName}. Check the "project" name and that the file is in the repository.`);
  }
  if (file.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const readers = [
    ['yq', ['-o=json', '.', file]],
    ['python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))', file]],
  ];
  for (const [command, args] of readers) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.status === 0) {
      return JSON.parse(result.stdout.trim() || 'null');
    }
    if (command === 'yq') {
      throw new UserError(`${displayName} is not valid YAML:\n${(result.stderr || '').trim()}`);
    }
  }
  throw new UserError('Could not read YAML on this runner. Use a GitHub-hosted ubuntu-latest runner, or install yq.');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return fallback;
}

function list(value, key, problems) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
    return value.map((item) => String(item).trim()).filter((item) => item !== '');
  }
  problems.push(`"${key}" must be a list of texts`);
  return [];
}

function folder(value, key, problems, { absolute }) {
  try {
    const parts = pathParts(text(value));
    return absolute ? '/' + parts.join('/') : parts.join('/');
  } catch {
    problems.push(`"${key}" may not contain ".."`);
    return absolute ? '/' : '';
  }
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const URL_PATTERN = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i;

/**
 * Check the raw config and fill in defaults.
 * @returns {object} The normalized config, with a `warnings` list.
 */
function parseConfig(raw, displayName = 'config.yaml') {
  const problems = [];
  const warnings = [];
  const data = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push('the file is empty');

  if (!['1', '1.0'].includes(text(data.version))) {
    problems.push('"version" must be 1.0');
  }

  // ---- deploy: (IONOS-compatible)
  const deploy = isObject(data.deploy) ? data.deploy : {};
  const force = text(deploy.force) || null;
  if (force !== null && force !== 'bootstrap' && force !== 'recurring') {
    problems.push('"deploy.force" must be bootstrap or recurring');
  }
  const block = (name) => {
    const values = isObject(deploy[name]) ? deploy[name] : {};
    return {
      excludes: list(values.excludes, `deploy.${name}.excludes`, problems),
      pre: list(values['pre-deployment-remote-commands'], `deploy.${name}.pre-deployment-remote-commands`, problems),
      post: list(values['post-deployment-remote-commands'], `deploy.${name}.post-deployment-remote-commands`, problems),
    };
  };

  // ---- runtime: (IONOS-compatible)
  const cronJobs = isObject(data.runtime) && Array.isArray(data.runtime['cron-jobs']) ? data.runtime['cron-jobs'] : [];
  if (cronJobs.length > 0) {
    warnings.push('runtime.cron-jobs is not supported yet and is ignored. GitNow will set up cron jobs through the all-inkl API in a later version.');
  }

  // ---- gitnow: (all-inkl)
  if (!isObject(data.gitnow)) {
    problems.push('the "gitnow:" section is missing. It tells GitNow where to deploy on all-inkl (see the README)');
  }
  const gitnow = isObject(data.gitnow) ? data.gitnow : {};

  const transport = text(gitnow.transport, 'ftps');
  if (transport === 'ssh') {
    problems.push('"gitnow.transport: ssh" is not available yet. Use ftps');
  } else if (transport !== 'ftps') {
    problems.push('"gitnow.transport" must be ftps');
  }

  const phpVersion = text(gitnow['php-version']);
  if (phpVersion !== '' && !/^\d+\.\d+$/.test(phpVersion)) {
    problems.push('"gitnow.php-version" must look like 8.3');
  }

  const environments = isObject(gitnow.environments) ? gitnow.environments : {};

  // production
  const production = isObject(environments.production) ? environments.production : null;
  if (production === null && isObject(data.gitnow)) {
    problems.push('"gitnow.environments.production" is missing');
  }
  const prod = production || {};
  const prodDomain = text(prod.domain).toLowerCase();
  const prodUrl = text(prod.url) || (prodDomain ? `https://${prodDomain}` : '');
  if (prodDomain !== '' && !HOSTNAME.test(prodDomain)) {
    problems.push(`"gitnow.environments.production.domain" is not a valid domain: ${prodDomain}`);
  }
  if (production !== null && prodUrl === '') {
    problems.push('set "gitnow.environments.production.domain", e.g. www.example.com');
  } else if (prodUrl !== '' && !URL_PATTERN.test(prodUrl)) {
    problems.push(`"gitnow.environments.production.url" is not a valid address: ${prodUrl}`);
  }

  // previews
  const previewValues = isObject(environments.previews) ? environments.previews : {};
  const previewsEnabled = previewValues.enabled === true || text(previewValues.enabled) === 'true';
  const previewDomain = text(previewValues.domain).toLowerCase();
  const previewUrl = text(previewValues.url);
  if (previewsEnabled) {
    if (previewDomain === '' && previewUrl === '') {
      problems.push('set "gitnow.environments.previews.domain" (e.g. preview.example.com) or turn previews off');
    }
    if (previewDomain !== '' && !HOSTNAME.test(previewDomain)) {
      problems.push(`"gitnow.environments.previews.domain" is not a valid domain: ${previewDomain}`);
    }
    if (previewUrl !== '' && !previewUrl.includes('{slug}')) {
      problems.push('"gitnow.environments.previews.url" must contain {slug}, e.g. https://{slug}.preview.example.com');
    }
  }

  const config = {
    deploy: { force, bootstrap: block('bootstrap'), recurring: block('recurring') },
    cronJobs,
    publishDir: text(gitnow['publish-dir'], './') || './',
    transport,
    basePath: folder(gitnow['base-path'] ?? '/', 'gitnow.base-path', problems, { absolute: true }),
    webRoot: folder(gitnow['web-root'] ?? '', 'gitnow.web-root', problems, { absolute: false }),
    phpVersion,
    phpCli: text(gitnow['php-cli']),
    production: {
      branch: text(prod.branch, 'main') || 'main',
      domain: prodDomain,
      url: prodUrl.replace(/\/+$/, ''),
      path: folder(prod.path ?? 'production', 'gitnow.environments.production.path', problems, { absolute: false }),
    },
    previews: {
      enabled: previewsEnabled,
      domain: previewDomain,
      url: previewUrl.replace(/\/+$/, ''),
      path: folder(previewValues.path ?? 'previews', 'gitnow.environments.previews.path', problems, { absolute: false }),
      excludeBranches: list(previewValues['exclude-branches'], 'gitnow.environments.previews.exclude-branches', problems),
    },
    warnings,
  };

  if (problems.length > 0) {
    throw new UserError(`${displayName} needs fixing:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

function loadConfig(file, displayName) {
  return parseConfig(readYamlFile(file, displayName), displayName);
}

module.exports = { BUILT_IN_EXCLUDES, parseConfig, loadConfig, readYamlFile };
