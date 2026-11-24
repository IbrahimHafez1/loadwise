// Generic fix examples for security rules. Each group keeps its own [code, note] entries in
// lib/security/examples.
import movedExamples from '../lib/security/examples/moved.cjs';
import injectionExamples from '../lib/security/examples/injection.cjs';
import requestForgeryExamples from '../lib/security/examples/request-forgery.cjs';
import authCryptoExamples from '../lib/security/examples/auth-crypto.cjs';
import exposureExamples from '../lib/security/examples/exposure.cjs';
import depsExamples from '../lib/security/examples/deps.cjs';
import filesExamples from '../lib/security/examples/files.cjs';
import type { FixExample } from './types/fix-example.cjs';

const examples: Record<string, readonly string[]> = {
  ...movedExamples,
  ...injectionExamples,
  ...requestForgeryExamples,
  ...authCryptoExamples,
  ...exposureExamples,
  ...depsExamples,
  ...filesExamples,
};

function exampleFor(ruleId: string, languageId: string): FixExample | undefined {
  if (!Object.hasOwn(examples, ruleId)) return;
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const [code, note] = examples[ruleId];
  return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', code, note };
}

export { exampleFor };
