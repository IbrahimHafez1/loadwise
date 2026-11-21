'use strict';

const rulePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function readRuleTokens(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const tokens = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return new Set(tokens.filter((token) => rulePattern.test(token)));
}

module.exports = { readRuleTokens };
