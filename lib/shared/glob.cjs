// @ts-check
'use strict';

// One glob dialect for every loadwise pattern (config ignore and overrides, workspace package lists): `*` matches
// within a folder, `**` any depth, `?` one character and `{a,b}` alternatives.
function globSource(rawPattern) {
  const pattern = rawPattern.replace(/(?:\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**');
  let source = '';
  let insideBraces = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      const slashFollows = pattern[index + 2] === '/';
      source += slashFollows ? '(?:.*/)?' : '.*';
      index += slashFollows ? 2 : 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{' && !insideBraces && pattern.indexOf('}', index + 1) !== -1) {
      insideBraces = true;
      source += '(?:';
    } else if (character === ',' && insideBraces) source += '|';
    else if (character === '}' && insideBraces) {
      insideBraces = false;
      source += ')';
    } else source += character.replace(/[.+^$[\]\\(){}|]/g, '\\$&');
  }
  return source;
}

function globExpression(pattern) {
  return new RegExp(`^${globSource(pattern)}$`);
}

// A pattern also matches everything below a folder it names, so "generated" and "generated/**" agree.
function createGlobMatcher(patterns) {
  const expressions = patterns.map((pattern) =>
    globExpression(pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')),
  );
  return function matches(relativeFile) {
    const parts = relativeFile.split('/');
    return parts.some((_, index) => {
      const candidate = parts.slice(0, index + 1).join('/');
      return expressions.some((expression) => expression.test(candidate));
    });
  };
}

module.exports = { createGlobMatcher, globExpression };
