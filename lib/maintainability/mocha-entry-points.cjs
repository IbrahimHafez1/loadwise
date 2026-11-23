'use strict';

// Files mocha loads, read from package.json scripts and .mocharc.yml, which config-entry-points.cjs cannot parse.
const mochaConfigYaml = /^\.mocharc\.ya?ml$/;
const commandBoundary = /&&|\|\||[;|]/;
// Mocha options that take a value; the value is not a spec.
const mochaValueFlags = new Set([
  '--config',
  '--reporter',
  '-R',
  '--reporter-option',
  '-O',
  '--timeout',
  '-t',
  '--ui',
  '-u',
  '--grep',
  '-g',
  '--fgrep',
  '-f',
  '--exclude',
  '--extension',
  '--slow',
  '-s',
  '--jobs',
  '-j',
  '--retries',
  '--package',
  '--watch-files',
  '--watch-ignore',
  '--node-option',
  '--require',
  '-r',
  '--file',
]);
const mochaLoadFlags = new Set(['--require', '-r', '--file']);

// Specs and loaded files that `mocha ...` names in one shell script, such as `mocha --recursive "spec/**/*.js"`.
function mochaScriptPaths(script) {
  const paths = [];
  for (const command of script.split(commandBoundary)) {
    const words = command.split(/\s+/).filter(Boolean);
    const mochaIndex = words.findIndex((word) => /(?:^|[\\/])mocha(?:\.cmd)?$/.test(word.replaceAll(/['"]/g, '')));
    if (mochaIndex === -1) continue;
    const rest = words.slice(mochaIndex + 1).map((word) => word.replaceAll(/^['"]|['"]$/g, ''));
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index];
      if (!word.startsWith('-')) {
        paths.push(word);
        continue;
      }
      const [flag, inlineValue] = word.split('=');
      const value = inlineValue ?? (mochaValueFlags.has(flag) ? rest[++index] : undefined);
      if (value && mochaLoadFlags.has(flag)) paths.push(value);
    }
  }
  return paths;
}

// `spec`, `file` and `require` entries of a .mocharc.yml: a scalar, an inline list or a block list.
function mochaYamlPaths(text) {
  const paths = [];
  let listing = false;
  for (const line of text.split(/\r?\n/)) {
    const option = line.match(/^(spec|file|require):\s*(.*?)\s*(?:#.*)?$/);
    if (option) {
      listing = option[2] === '';
      const values = option[2].replace(/^\[|\]$/g, '').split(',');
      for (const value of values) if (value.trim()) paths.push(value.trim().replaceAll(/^['"]|['"]$/g, ''));
      continue;
    }
    const item = listing && line.match(/^\s+-\s*(.*?)\s*(?:#.*)?$/);
    if (item) paths.push(item[1].replaceAll(/^['"]|['"]$/g, ''));
    else if (/^\S/.test(line)) listing = false;
  }
  return paths;
}

module.exports = { mochaConfigYaml, mochaScriptPaths, mochaYamlPaths };
