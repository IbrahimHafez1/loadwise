// @ts-check
// One glob dialect for every loadwise pattern (config ignore and overrides, workspace package lists): `*` matches
// within a folder, `**` any depth, `?` one character and `{a,b}` alternatives.
function globSource(rawPattern: string) {
  const pattern = rawPattern.replaceAll(/(?:\*\*\/)+/g, '**/').replaceAll(/\*{3,}/g, '**');
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
    } else source += character.replaceAll(/[.+^$[\]\\(){}|]/g, '\\$&');
  }
  return source;
}

function globExpression(pattern: string) {
  return new RegExp(`^${globSource(pattern)}$`);
}

// A pattern also matches everything below a folder it names, so "generated" and "generated/**"
// agree.
function createGlobMatcher(patterns: readonly string[]) {
  const expressions = patterns.map((pattern: string) =>
    globExpression(pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')),
  );
  return function matches(relativeFile: string) {
    const parts = relativeFile.split('/');
    return parts.some((_: string, index: number) => {
      const candidate = parts.slice(0, index + 1).join('/');
      return expressions.some((expression: RegExp) => expression.test(candidate));
    });
  };
}

export { createGlobMatcher, globExpression };
