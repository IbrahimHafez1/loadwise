const rulePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function readRuleTokens(markdown: string): Set<string> {
  const prose = markdown.replaceAll(/```[\s\S]*?```/g, '');
  const tokens = [...prose.matchAll(/`([^`\n]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return new Set(tokens.filter((token) => rulePattern.test(token)));
}

export { readRuleTokens };
