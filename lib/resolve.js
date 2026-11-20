'use strict';

// Decides what a branch deploys to: production, a preview, or nothing.

const crypto = require('node:crypto');
const { globToRegExp } = require('./excludes');
const { joinRemote } = require('./paths');

const MAX_SLUG_LENGTH = 40;

/** A branch name as a subdomain label: "feature/New Header" → "feature-new-header". */
function slugify(branch) {
  const hash = crypto.createHash('sha1').update(branch).digest('hex').slice(0, 6);
  let slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug === '') return `branch-${hash}`;
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = `${slug.slice(0, MAX_SLUG_LENGTH - 7).replace(/-+$/, '')}-${hash}`;
  }
  return slug;
}

function disabled(reason) {
  return { enabled: false, reason, kind: '', environment: '', slug: '', siteUrl: '', targetPath: '' };
}

/**
 * @returns {{enabled: boolean, reason: string, kind: string, environment: string, slug: string,
 *            siteUrl: string, targetPath: string}}
 */
function resolveEnvironment(config, branch) {
  if (!branch) {
    return disabled('GitNow could not tell which branch this run is for.');
  }

  const { production, previews } = config;
  if (branch === production.branch) {
    return {
      enabled: true,
      reason: '',
      kind: 'production',
      environment: 'production',
      slug: '',
      siteUrl: production.url,
      targetPath: joinRemote(config.basePath, production.path),
    };
  }

  if (!previews.enabled) {
    return disabled(`Branch "${branch}" is not deployed: only "${production.branch}" goes live, and preview sites are turned off.`);
  }
  const excluded = previews.excludeBranches.find((pattern) => globToRegExp(pattern).test(branch));
  if (excluded) {
    return disabled(`Branch "${branch}" gets no preview site because it matches "${excluded}" in exclude-branches.`);
  }

  const slug = slugify(branch);
  return {
    enabled: true,
    reason: '',
    kind: 'preview',
    environment: `preview-${slug}`,
    slug,
    siteUrl: previews.url ? previews.url.replace('{slug}', slug) : `https://${slug}.${previews.domain}`,
    targetPath: joinRemote(config.basePath, previews.path, slug),
  };
}

module.exports = { slugify, resolveEnvironment };
