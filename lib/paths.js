'use strict';

/** Split a path into its parts, refusing ".." so a config can't point outside the FTP folder. */
function pathParts(value) {
  const parts = String(value).replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new Error(`"${value}" may not contain ".."`);
  }
  return parts;
}

/** Join parts into an absolute path on the FTP server: joinRemote('/site/', 'production') → '/site/production'. */
function joinRemote(...segments) {
  return '/' + segments.flatMap((segment) => pathParts(segment)).join('/');
}

/** Join parts into a relative path: joinRelative('public', 'x.php') → 'public/x.php'. */
function joinRelative(...segments) {
  return segments.flatMap((segment) => pathParts(segment)).join('/');
}

module.exports = { pathParts, joinRemote, joinRelative };
