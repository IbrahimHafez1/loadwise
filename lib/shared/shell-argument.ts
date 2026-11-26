// Copyable CLI examples target PowerShell on Windows and a POSIX shell elsewhere.
function quoteArgument(argument: string) {
  if (/^[a-z0-9_./:-][a-z0-9_./:@-]*$/i.test(argument)) return argument;
  // PowerShell also treats typographic single quotes as string delimiters.
  const escaped =
    process.platform === 'win32' ? argument.replaceAll(/['\u2018-\u201B]/g, "'$&") : argument.replaceAll("'", "'\\''");
  return "'" + escaped + "'";
}

export { quoteArgument };
