'use strict';

// Small replacement for @actions/core: inputs, outputs, logging and the job summary,
// using GitHub's workflow commands and environment files directly.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

/** A problem with the user's setup. Shown as a plain error message, without a stack trace. */
class UserError extends Error {}

function getInput(name, { required = false } = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = (process.env[key] || '').trim();
  if (required && value === '') {
    throw new UserError(`The input "${name}" is missing.`);
  }
  return value;
}

function getBooleanInput(name, fallback) {
  const value = getInput(name).toLowerCase();
  if (value === '') return fallback;
  if (['true', 'yes', '1', 'on'].includes(value)) return true;
  if (['false', 'no', '0', 'off'].includes(value)) return false;
  throw new UserError(`The input "${name}" must be true or false.`);
}

/** Read an input that holds a JSON object, like ${{ toJSON(secrets) }}. */
function getJsonInput(name) {
  const value = getInput(name);
  if (value === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UserError(`The input "${name}" is not valid JSON.`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function appendEnvFile(envName, key, value) {
  const file = process.env[envName];
  if (!file) return false;
  const delimiter = `gitnow_${crypto.randomBytes(8).toString('hex')}`;
  fs.appendFileSync(file, `${key}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
  return true;
}

function setOutput(name, value) {
  if (!appendEnvFile('GITHUB_OUTPUT', name, String(value))) {
    console.log(`output ${name}=${value}`);
  }
}

/** Hide a value in all later log output. */
function mask(value) {
  for (const line of String(value || '').split(/\r?\n/)) {
    if (line.trim() !== '') console.log(`::add-mask::${escapeData(line)}`);
  }
}

const log = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${escapeData(message)}`),
  warning: (message) => console.log(`::warning::${escapeData(message)}`),
  error: (message) => console.log(`::error::${escapeData(message)}`),
  async group(title, callback) {
    console.log(`::group::${escapeData(title)}`);
    try {
      return await callback();
    } finally {
      console.log('::endgroup::');
    }
  },
};

function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, markdown + os.EOL);
}

/** Run an action's main function and turn errors into a failed step. */
function run(main) {
  Promise.resolve()
    .then(main)
    .catch((error) => {
      log.error(error.message);
      if (!(error instanceof UserError)) console.error(error.stack);
      process.exitCode = 1;
    });
}

module.exports = {
  UserError,
  getInput,
  getBooleanInput,
  getJsonInput,
  setOutput,
  mask,
  log,
  addSummary,
  run,
};
