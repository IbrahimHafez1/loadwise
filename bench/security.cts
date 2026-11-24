import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { withProgram } from '../test/performance/helpers.cjs';
import { loadSyntax } from '../lib/performance/compiler.cjs';
import { createSummaries } from '../lib/security/taint/summaries.cjs';
import type { CallExpression, FunctionDeclaration } from 'typescript';
import type { ProgramAdapter } from '../lib/shared/types.cjs';
const ts = loadSyntax();

interface Workload {
  name: string;
  modules: number;
  callsPerModule: number;
}

interface LookupTimings {
  indexAndFirstLookup: number;
  otherLookups: number;
  repeatLookups: number;
}

const workloads: Workload[] = [
  { name: 'small', modules: 4, callsPerModule: 20 },
  { name: 'large', modules: 30, callsPerModule: 400 },
];
const warmups = 2;
const samples = 7;
const repeatLookups = 5;
const lookupPhases: (keyof LookupTimings)[] = ['indexAndFirstLookup', 'otherLookups', 'repeatLookups'];

function measure(
  program: ProgramAdapter,
  declarations: readonly FunctionDeclaration[],
  callsPerModule: number,
): LookupTimings {
  const summaries = createSummaries(program);
  const started = performance.now();
  const first = summaries.callSites(declarations[0]);
  const indexed = performance.now();
  const sites = declarations.slice(1).map((declaration) => summaries.callSites(declaration));
  const lookedUp = performance.now();
  for (let round = 0; round < repeatLookups; round++) {
    for (const declaration of declarations) summaries.callSites(declaration);
  }
  const finished = performance.now();
  for (const [index, calls] of [first, ...sites].entries()) {
    const source = declarations[index].getSourceFile();
    assert.equal(calls.length, callsPerModule);
    assert.ok(
      calls.every((call: CallExpression, siteIndex: number) => {
        const statement = source.statements[siteIndex + 1];
        return (
          call.getSourceFile() === source &&
          ts.isExpressionStatement(statement) &&
          call.pos === statement.expression.pos
        );
      }),
    );
  }
  return {
    indexAndFirstLookup: indexed - started,
    otherLookups: lookedUp - indexed,
    repeatLookups: finished - lookedUp,
  };
}

function benchmark({ name, modules, callsPerModule }: Workload): void {
  const body = [
    'export function record(value: string) { return value; }',
    ...Array(callsPerModule).fill("record('item');"),
  ].join('\n');
  const files = Object.fromEntries(Array.from({ length: modules }, (_, index) => [`service-${index}.ts`, body]));
  withProgram('export {};', files, (program: ProgramAdapter) => {
    if (!program.getSourceFiles) throw new Error('Expected a TypeScript program with source files.');
    const declarations = program
      .getSourceFiles()
      .flatMap((file) => file.statements.filter(ts.isFunctionDeclaration))
      .filter((declaration) => declaration.body && declaration.name?.text === 'record');
    assert.equal(declarations.length, modules);
    for (let run = 0; run < warmups; run++) measure(program, declarations, callsPerModule);
    const timings = Array.from({ length: samples }, () => measure(program, declarations, callsPerModule));
    console.log(`${name}: ${modules} modules, ${modules * callsPerModule} same-name call sites`);
    for (const phase of lookupPhases) {
      const durations = timings.map((sample) => sample[phase]).sort((left, right) => left - right);
      console.log(`  ${phase}: ${durations[Math.floor(samples / 2)].toFixed(2)} ms median`);
    }
  });
}

console.log(
  `Node ${process.version}; ${samples} samples after ${warmups} warmups; exact first-pass call sites checked.`,
);
for (const workload of workloads) benchmark(workload);
