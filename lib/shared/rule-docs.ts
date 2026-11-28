import { pillarOfRule } from './rule-registry.js';

const repositoryUrl = 'https://github.com/IbrahimHafez1/loadwise';
const rulePagesUrl = `${repositoryUrl}/blob/main/docs/rules`;

// syntax-error skips the unparsable file instead of becoming a finding, so it has no page.
const undocumentedRules: ReadonlySet<string> = new Set(['syntax-error']);

/** The documentation page of a registered rule, or undefined for an id with no page. */
function ruleDocUrl(ruleId: string): string | undefined {
  if (!pillarOfRule(ruleId) || undocumentedRules.has(ruleId)) return undefined;
  return `${rulePagesUrl}/${ruleId}.md`;
}

export { repositoryUrl, ruleDocUrl, undocumentedRules };
