'use strict';

// Generic fix examples for security rules. Each group keeps its own [code, note] entries in lib/security/examples.
const groups = ['moved', 'injection', 'request-forgery', 'auth-crypto', 'exposure', 'files'];
const examples = Object.assign({}, ...groups.map((group) => require(`../lib/security/examples/${group}.cjs`)));

function exampleFor(ruleId, languageId) {
  if (!Object.hasOwn(examples, ruleId)) return;
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const [code, note] = examples[ruleId];
  return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', code, note };
}

module.exports = { exampleFor };
