// @ts-check
'use strict';

// Copyable CLI examples target PowerShell on Windows and a POSIX shell elsewhere.
function quoteArgument(argument) {
  if (/^[a-z0-9_./:-][a-z0-9_./:@-]*$/i.test(argument)) return argument;
  // PowerShell also treats typographic single quotes as string delimiters.
  const escaped =
    process.platform === 'win32' ? argument.replace(/['\u2018-\u201B]/g, "'$&") : argument.replaceAll("'", "'\\''");
  return "'" + escaped + "'";
}

module.exports = { quoteArgument };
