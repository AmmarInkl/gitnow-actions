'use strict';

// Renders .deploy-now/<project>/**/*.template into the site before upload, e.g.
// .env.template → .env. Same syntax as IONOS Deploy Now:
//   $NAME   ${NAME}   ${NAME.urlEncoded()}
// Names without a value are left as they are.

const fs = require('node:fs');
const path = require('node:path');

const SUFFIX = '.template';
const VARIABLE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\.urlEncoded\(\))?\s*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function renderString(text, values) {
  const unknown = new Set();
  const output = text.replace(VARIABLE, (match, braced, encoded, bare) => {
    const name = braced || bare;
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      unknown.add(name);
      return match;
    }
    const value = String(values[name]);
    return encoded ? encodeURIComponent(value) : value;
  });
  return { text: output, unknown: [...unknown] };
}

/**
 * The values templates can use: repository variables, then secrets, then GitNow's own
 * values (which can't be overridden). GITHUB_TOKEN is never offered.
 */
function templateValues({ siteUrl, environment, branch, commit, secrets = {}, variables = {} }) {
  const values = {};
  for (const [name, value] of Object.entries(variables)) {
    values[name.toUpperCase()] = String(value);
  }
  for (const [name, value] of Object.entries(secrets)) {
    if (name.toUpperCase() !== 'GITHUB_TOKEN') values[name.toUpperCase()] = String(value);
  }
  Object.assign(values, {
    GITNOW_APP_URL: siteUrl,
    GITNOW_ENVIRONMENT: environment,
    GITNOW_BRANCH: branch,
    GITNOW_COMMIT: commit,
    // Lets templates written for IONOS Deploy Now keep working.
    IONOS_APP_URL: siteUrl,
  });
  return values;
}

function findTemplates(dir, relative = '') {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...findTemplates(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith(SUFFIX) && entry.name !== SUFFIX) {
      found.push(rel);
    }
  }
  return found.sort();
}

/** @returns {{files: string[], unknown: string[]}} Written files (relative to outputDir) and names without a value. */
function renderTemplates(templateDir, outputDir, values) {
  const files = [];
  const unknown = new Set();
  for (const rel of findTemplates(templateDir)) {
    const target = rel.slice(0, -SUFFIX.length);
    const rendered = renderString(fs.readFileSync(path.join(templateDir, rel), 'utf8'), values);
    const destination = path.join(outputDir, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, rendered.text);
    files.push(target);
    rendered.unknown.forEach((name) => unknown.add(name));
  }
  return { files, unknown: [...unknown].sort() };
}

module.exports = { renderString, templateValues, renderTemplates, findTemplates };
