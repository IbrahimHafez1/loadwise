// One minimal sample per accessibility fix builder.
import type { FixVerificationCase } from '../../../types/fix-verification.js';

const buttonInForm = [
  'export function SaveForm() {',
  '  return (',
  '    <form>',
  '      <button onClick={() => undefined}>Save draft</button>',
  '    </form>',
  '  );',
  '}',
  '',
].join('\n');

const accessibilityCases: FixVerificationCase[] = [
  {
    ruleId: 'a11y-button-missing-type',
    files: { 'package.json': JSON.stringify({ private: true, type: 'module' }), 'SaveForm.tsx': buttonInForm },
  },
];

export { accessibilityCases };
