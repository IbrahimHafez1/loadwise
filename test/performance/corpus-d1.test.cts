import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { lint } from './helpers.cjs';
import { requireFix, requireOnlyChange, scanWithFixes } from './site-fix-helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const rule = 'serial-awaits-in-literal';
const header =
  'declare function loadSeats(): Promise<number>;\ndeclare function loadFlows(id?: number): Promise<number>;\n';

function findings(source: string) {
  return lint(source).filter((finding: Finding) => finding.ruleId === rule);
}

function fixOf(context: TestContext, source: string) {
  const { findings: scanned } = scanWithFixes(context, { 'src/service.ts': source });
  const finding = scanned.find((entry) => entry.ruleId === rule);
  assert.ok(finding?.fix, 'rule should report with a fix');
  return requireOnlyChange(finding).after;
}

const x509Header =
  "import * as x509 from '@peculiar/x509';\nimport { SubjectKeyIdentifierExtension } from '@peculiar/x509';\n" +
  'declare const key: CryptoKey;\ndeclare const cert: x509.X509Certificate;\n';

test('awaits that only wrap in-process certificate or digest work are quiet', () => {
  assert.deepEqual(
    findings(
      `${x509Header}export async function run() {\n  return [await x509.AuthorityKeyIdentifierExtension.create(cert, false), await SubjectKeyIdentifierExtension.create(key)];\n}`,
    ),
    [],
  );
  assert.deepEqual(
    findings(
      'declare const data: Uint8Array;\nexport async function run() {\n  return { a: await crypto.subtle.digest("SHA-256", data), b: await globalThis.crypto.subtle.digest("SHA-1", data) };\n}',
    ),
    [],
  );
});

test('one in-process await next to one I/O await is quiet, two I/O awaits still report', () => {
  assert.deepEqual(
    findings(
      `${x509Header}${header}export async function run() {\n  return [await x509.SubjectKeyIdentifierExtension.create(key), await loadSeats()];\n}`,
    ),
    [],
  );
  assert.equal(
    findings(
      `${x509Header}${header}export async function run() {\n  return [await x509.SubjectKeyIdentifierExtension.create(key), await loadSeats(), await loadFlows()];\n}`,
    ).length,
    1,
  );
  assert.equal(
    findings(
      `import * as store from './store';\nexport async function run() {\n  return [await store.Seats.create(), await store.Flows.create()];\n}`,
    ).length,
    1,
  );
});

test('the serial arm of a conditional whose other arm runs the same calls in Promise.all is quiet', () => {
  const body = (expression: string) =>
    `${header}export async function run(manager: unknown) {\n  return ${expression};\n}`;
  assert.deepEqual(
    findings(
      body(
        'manager ? ([await loadSeats(), await loadFlows()] as const) : await Promise.all([loadSeats(), loadFlows()])',
      ),
    ),
    [],
  );
  assert.equal(
    findings(body('manager ? [await loadSeats(), await loadFlows()] : await Promise.all([loadSeats()])')).length,
    1,
  );
  assert.equal(findings(body('manager ? [await loadSeats(), await loadFlows()] : []')).length, 1);
});

test('hoisted values take the property names and the literal uses shorthand', (context) => {
  const after = fixOf(
    context,
    `${header}export async function run() {\n  return { seats: await loadSeats(), label: 'x', flows: await loadFlows() };\n}`,
  );
  assert.equal(
    after,
    "const [seats, flows] = await Promise.all([loadSeats(), loadFlows()]);\nreturn { seats, label: 'x', flows };",
  );
});

test('a property name already used in the function falls back to a Result name', (context) => {
  const after = fixOf(
    context,
    `${header}export async function run(seats: number) {\n  return { seats: await loadSeats(), flows: await loadFlows(seats) };\n}`,
  );
  assert.match(after, /const \[seatsResult, flows\] = await Promise\.all\(\[loadSeats\(\), loadFlows\(seats\)\]\);/);
  assert.match(after, /return \{ seats: seatsResult, flows \};/);
});

test('a name used only in another function or as a property still becomes the binding', (context) => {
  const after = fixOf(
    context,
    `${header}function other(seats: number) { return seats; }\nexport async function run(input: { flows: number }) {\n  return { seats: await loadSeats(), flows: await loadFlows(input.flows) };\n}`,
  );
  assert.match(after, /const \[seats, flows\] = await Promise\.all/);
});

test('reserved words and comments between key and value keep the long form', (context) => {
  const after = fixOf(
    context,
    `${header}export async function run() {\n  return { default: await loadSeats(), flows: /* n */ await loadFlows() };\n}`,
  );
  assert.match(after, /const \[defaultResult, flows\] = await Promise\.all/);
  assert.match(after, /return \{ default: defaultResult, flows: \/\* n \*\/ flows \};/);
});

test('long or multi-line calls are put one per line and re-indented', (context) => {
  const source = `${header}declare const service: { loadSubscriptions(options: object): Promise<number>; loadCurrent(id: number): Promise<number> };
export class Resolver {
  async run(workspaceId: number) {
    return {
      billingSubscriptions:
        await service.loadSubscriptions({
          where: { workspaceId },
        }),
      currentBillingSubscription: await service.loadCurrent(workspaceId),
    };
  }
}
`;
  const after = fixOf(context, source);
  assert.equal(
    after,
    [
      'const [billingSubscriptions, currentBillingSubscription] = await Promise.all([',
      '  service.loadSubscriptions({',
      '    where: { workspaceId },',
      '  }),',
      '  service.loadCurrent(workspaceId),',
      ']);',
      'return {',
      '  billingSubscriptions,',
      '  currentBillingSubscription,',
    ].join('\n'),
  );
});

test('a multi-line array literal becomes a multi-line Promise.all at the file indentation', (context) => {
  const source = `${header}export async function run() {
    const [seats, flows] = [
        await loadSeats(),
        await loadFlows(),
    ];
    return seats + flows;
}
`;
  const after = fixOf(context, source);
  assert.equal(after, 'const [seats, flows] = await Promise.all([\n    loadSeats(),\n    loadFlows(),\n]);');
});

test('a concise arrow body is re-indented one step inside the new block', (context) => {
  const source = `${header}export const handlers = {
  build: async () => ({
    seats: await loadSeats(),
    flows: await loadFlows(),
  }),
};
`;
  const { findings: scanned } = scanWithFixes(context, { 'src/service.ts': source });
  const finding = scanned.find((entry) => entry.ruleId === rule);
  assert.equal(
    requireFix(finding).changes[0].after,
    [
      '  build: async () => {',
      '    const [seats, flows] = await Promise.all([loadSeats(), loadFlows()]);',
      '    return {',
      '      seats,',
      '      flows,',
      '    };',
      '  },',
    ].join('\n'),
  );
});

test('a multi-line template literal keeps its text when the arrow body is converted', (context) => {
  const source = `${header}export const build = async () => ({
  seats: await loadSeats(),
  text: \`a
b\`,
  flows: await loadFlows(),
});
`;
  const { findings: scanned } = scanWithFixes(context, { 'src/service.ts': source });
  const finding = scanned.find((entry) => entry.ruleId === rule);
  assert.match(requireFix(finding).changes[0].after, /text: `a\nb`,/);
});
