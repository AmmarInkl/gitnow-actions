'use strict';

// Exclude patterns, in the spirit of rsync:
//   node_modules     no slash: matches a file or folder with that name anywhere
//   *.log            wildcards: * and ? stay inside one path part, ** crosses folders
//   /storage         leading slash: only at the top of the deploy folder
//   storage/logs     a slash inside: a path from the top of the deploy folder
//   cache/           trailing slash: same as "cache" (folders and files)
// A path is excluded when it, or any folder above it, matches.

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function compilePattern(pattern) {
  let value = String(pattern).trim().replace(/\\/g, '/');
  if (value.startsWith('./')) value = value.slice(2);
  const anchored = value.startsWith('/') || value.replace(/\/+$/, '').includes('/');
  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (value === '') return null;
  return { anchored, regex: globToRegExp(value) };
}

/** @returns {(relativePath: string) => boolean} */
function compileExcludes(patterns) {
  const compiled = patterns.map(compilePattern).filter(Boolean);
  return (relativePath) => {
    const parts = relativePath.split('/').filter(Boolean);
    for (const { anchored, regex } of compiled) {
      if (anchored) {
        for (let i = 1; i <= parts.length; i++) {
          if (regex.test(parts.slice(0, i).join('/'))) return true;
        }
      } else if (parts.some((part) => regex.test(part))) {
        return true;
      }
    }
    return false;
  };
}

module.exports = { compileExcludes, globToRegExp };
