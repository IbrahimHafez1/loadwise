// @ts-check
import * as performance from '../performance/rule-ids.js';
import * as maintainability from '../maintainability/rule-ids.js';
import * as security from '../security/rule-ids.js';
import type { FixExample } from '../../editor/types/fix-example.cjs';
import { exampleFor } from '../../editor/performance-examples.cjs';
import { exampleFor as exampleForMaintainabilityExamples } from '../../editor/maintainability-examples.cjs';
import { descriptionByRule } from '../security/rule-descriptions.js';
import { exampleFor as exampleForSecurityExamples } from '../../editor/security-examples.cjs';

interface RuleChecker {
  name: string;
  impactByRule: Readonly<Record<string, string>>;
  descriptionByRule: Readonly<Record<string, string>>;
  exampleFor(ruleId: string, language: string, message: string): FixExample | undefined;
}

const checkers: RuleChecker[] = [
  {
    name: 'Performance',
    ...performance,
    exampleFor: exampleFor,
  },
  {
    name: 'Maintainability',
    ...maintainability,
    exampleFor: exampleForMaintainabilityExamples,
  },
  {
    name: 'Security',
    impactByRule: security.impactByRule,
    descriptionByRule: descriptionByRule,
    exampleFor: exampleForSecurityExamples,
  },
];

function explainRule(ruleId: string): string {
  const checker = checkers.find(({ impactByRule }) => Object.hasOwn(impactByRule, ruleId));
  if (!checker) throw new Error(`Unknown rule "${ruleId}". Use the rule name shown before the #finding-id.`);
  const language = /^(python|csharp|java|go|rust)-/.exec(ruleId)?.[1] ?? 'typescript';
  const example = checker.exampleFor(ruleId, language, '');
  const lines: string[] = [
    `${ruleId} (${checker.name}, default impact ${checker.impactByRule[ruleId]})`,
    checker.descriptionByRule[ruleId],
  ];
  if (example) lines.push('', 'Example change', example.code, '', example.note ?? '');
  return lines.join('\n');
}

function runExplain(args: readonly string[]) {
  const usage = 'Usage: loadwise explain <rule-id>';
  if (args.length !== 1) throw new Error(usage);
  console.log(['--help', '-h'].includes(args[0]) ? usage : explainRule(args[0]));
  return 0;
}

export { explainRule, runExplain };
