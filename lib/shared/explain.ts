import { pillarOfRule, rulesByPillar } from './rule-registry.js';
import type { FixExample } from '../editor/types/fix-example.js';
import type { PillarName } from './types/pillar-name.js';
import { exampleFor } from '../editor/performance-examples.js';
import { exampleFor as exampleForReliabilityExamples } from '../editor/reliability-examples.js';
import { exampleFor as exampleForMaintainabilityExamples } from '../editor/maintainability-examples.js';
import { exampleFor as exampleForSecurityExamples } from '../editor/security-examples.js';
import { exampleFor as exampleForAccessibilityExamples } from '../editor/accessibility-examples.js';

interface ExplainedPillar {
  name: string;
  exampleFor(ruleId: string, language: string, message: string): FixExample | undefined;
}

const explainedPillars: Record<PillarName, ExplainedPillar> = {
  performance: { name: 'Performance', exampleFor },
  reliability: { name: 'Reliability', exampleFor: exampleForReliabilityExamples },
  maintainability: { name: 'Maintainability', exampleFor: exampleForMaintainabilityExamples },
  security: { name: 'Security', exampleFor: exampleForSecurityExamples },
  accessibility: { name: 'Accessibility', exampleFor: exampleForAccessibilityExamples },
};

function explainRule(ruleId: string): string {
  const pillar = pillarOfRule(ruleId);
  if (!pillar) throw new Error(`Unknown rule "${ruleId}". Use the rule name shown before the #finding-id.`);
  const { name, exampleFor: pillarExample } = explainedPillars[pillar];
  const { impactByRule, descriptionByRule } = rulesByPillar[pillar];
  const language = /^(python|csharp|java|go|rust)-/.exec(ruleId)?.[1] ?? 'typescript';
  const example = pillarExample(ruleId, language, '');
  const lines: string[] = [`${ruleId} (${name}, default impact ${impactByRule[ruleId]})`, descriptionByRule[ruleId]];
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
