'use strict';

const performance = require('../performance/rule-ids.cjs');
const maintainability = require('../maintainability/rule-ids.cjs');
const security = require('../security/rule-ids.cjs');

const checkers = [
  { name: 'Performance', ...performance, exampleFor: require('../../editor/performance-examples.cjs').exampleFor },
  {
    name: 'Maintainability',
    ...maintainability,
    exampleFor: require('../../editor/maintainability-examples.cjs').exampleFor,
  },
  {
    name: 'Security',
    impactByRule: security.impactByRule,
    descriptionByRule: require('../security/rule-descriptions.cjs').descriptionByRule,
    exampleFor: require('../../editor/security-examples.cjs').exampleFor,
  },
];

function explainRule(ruleId) {
  const checker = checkers.find(({ impactByRule }) => Object.hasOwn(impactByRule, ruleId));
  if (!checker) throw new Error(`Unknown rule "${ruleId}". Use the rule name shown before the #finding-id.`);
  const language = /^(python|csharp|java|go|rust)-/.exec(ruleId)?.[1] ?? 'typescript';
  const example = checker.exampleFor(ruleId, language, '');
  const lines = [
    `${ruleId} (${checker.name}, default impact ${checker.impactByRule[ruleId]})`,
    checker.descriptionByRule[ruleId],
  ];
  if (example) lines.push('', 'Example change', example.code, '', example.note);
  return lines.join('\n');
}

function runExplain(args) {
  const usage = 'Usage: loadwise explain <rule-id>';
  if (args.length !== 1) throw new Error(usage);
  console.log(['--help', '-h'].includes(args[0]) ? usage : explainRule(args[0]));
  return 0;
}

module.exports = { explainRule, runExplain };
