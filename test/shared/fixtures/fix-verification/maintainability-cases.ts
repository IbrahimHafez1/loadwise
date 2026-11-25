// One minimal sample per maintainability fix builder, taken from the rule's own tests.
import type { MaintainabilityVerificationCase } from '../../../types/fix-verification.js';
import type { FileMap } from '../../../types/project-files.js';

const packageManifest = JSON.stringify({ private: true, type: 'module' });

function sample(ruleId: string, files: FileMap): MaintainabilityVerificationCase {
  return { ruleId, files: { 'package.json': packageManifest, ...files } };
}

const nestedLoops = [
  'export function collect(rows, limit) {',
  '  const found = [];',
  '  for (const row of rows) {',
  '    if (row.active) {',
  '      for (const tag of row.tags) {',
  '        if (tag.length > limit) {',
  '          found.push(tag);',
  '        }',
  '      }',
  '    }',
  '  }',
  '  return found;',
  '}',
  '',
].join('\n');

const branchyScore = [
  'export function score(input) {',
  '  let points = 0;',
  '  const record = input;',
  '  if (!record.name) record.name = "anonymous";',
  '  if (input.blocked) return -1;',
  '  if (input.deleted) return -1;',
  '  const verified = input.email ? true : false;',
  ...Array.from({ length: 11 }, (_, index) => `  if (input.level === ${index}) points += ${index};`),
  '  return points + (verified ? 1 : 0);',
  '}',
  '',
].join('\n');

const sharedFunction = [
  'export function sameDay(first, second) {',
  '  const left = new Date(first);',
  '  const right = new Date(second);',
  '  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCDate() === right.getUTCDate();',
  '}',
  '',
].join('\n');

const copiedFunction = [
  "import { strict } from 'node:assert';",
  '',
  'export class Usage {',
  '  sameDay(first, second) {',
  '    const left = new Date(first);',
  '    const right = new Date(second);',
  '    return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCDate() === right.getUTCDate();',
  '  }',
  '  check() {',
  '    strict.ok(this);',
  '  }',
  '}',
  '',
].join('\n');

const longParameterList = [
  'export function render() {',
  '  const log: number[] = [];',
  '  const step = (n: number) => (log.push(n), n);',
  '  const draw = (a: number, b: number, c: number, d: number, e: number, scale = 1) =>',
  '    [a, b, c, d, e].map(value => value * scale);',
  '  const first = draw(step(1), step(2), step(3), step(4), step(5));',
  '  const second = draw(1, 2, 3, 4, 5, step(6));',
  '  return [first, second, log];',
  '}',
  '',
].join('\n');

const largeRecord = [
  'interface Packet {',
  '  when: Date;',
  ...Array.from({ length: 20 }, (_, index) => `  field${index}: Array<string | null>;`),
  '}',
  'export function inspect(packet: Packet) { return packet.when; }',
  // The rule reports past 600 lines, and moving the record has to bring the module back under that
  // limit.
  ...Array.from({ length: 580 }, (_, index) => `export const value${index} = ${index};`),
  '',
].join('\n');

const maintainabilityCases: MaintainabilityVerificationCase[] = [
  sample('deep-control-flow', { 'collect.js': nestedLoops }),
  sample('high-branch-complexity', { 'score.js': branchyScore }),
  sample('duplicate-implementation', { 'utils/day.mjs': sharedFunction, 'usage.mjs': copiedFunction }),
  sample('dependency-cycle', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    'a.ts': [
      "import { Shape } from './b';",
      'export const unit = 1;',
      'export const area = (shape: Shape) => shape.size * unit;',
      '',
    ].join('\n'),
    'b.ts': [
      "import { unit } from './a';",
      'export interface Shape { size: number }',
      'export const scale = unit * 2;',
      '',
    ].join('\n'),
  }),
  sample('long-parameter-list', { 'render.ts': longParameterList }),
  sample('large-module', { 'api.ts': largeRecord }),
];

export { maintainabilityCases };
