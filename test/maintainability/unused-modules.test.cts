import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scan } from '../../lib/maintainability/scan.cjs';
import { defaultLimits } from '../../lib/maintainability/limits.cjs';
import type { MaintainabilityPolicy } from '../../lib/maintainability/types/policy.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { fixOf } from '../types/finding-fix.cjs';
import { reasonOf } from '../types/finding-reason.cjs';
import { dockerNodeEntry, localDockerBuild } from '../../lib/maintainability/docker-entry-points.cjs';

const policy: MaintainabilityPolicy = { exclude: [], boundaries: [], placement: [], limits: defaultLimits };

async function scanProject(files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-unused-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const report = await scan(root, policy);
    return report.findings.filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const summary = (findings: Finding[]) => findings.map((finding: Finding) => `${finding.ruleId} ${finding.file}`).sort();

const privateApp: FileMap = {
  'package.json': '{"private":true}',
  'src/index.ts': 'import { run } from "./helpers"; run();',
  'src/helpers.ts': [
    'export interface Payload { id: string }',
    'export type Options = { retry: boolean };',
    'export function run(): string { const p: Payload = {id: "x"}; const o: Options = {retry:true}; return o.retry ? p.id : ""; }',
  ].join('\n'),
};

test('offers only export removal for private-app types with local consumers', async () => {
  const findings = await scanProject(privateApp);
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    const fix = fixOf(finding);
    assert.equal(fix.requiresReview, true);
    const [change] = fix.changes;
    assert.equal(change.file, 'src/helpers.ts');
    assert.equal(change.before, 'export ' + change.after);
    assert.equal(change.before, privateApp[change.file].split('\n')[change.line - 1]);
  }
  const source = privateApp['src/helpers.ts'].replaceAll(/^export (interface|type)/gm, '$1');
  assert.deepEqual(await scanProject({ ...privateApp, 'src/helpers.ts': source }), []);
});

test('withholds export removal for public or published APIs and ambiguous imports', async () => {
  const variants: FileMap[] = [
    { 'package.json': '{}' },
    { 'package.json': '{"private":true,"types":"./dist/public.d.ts"}' },
    { 'src/barrel.ts': 'export * from "./helpers";' },
    { 'src/barrel.ts': 'export type { Payload as PublicData, Options } from "./helpers";' },
    { 'src/external.ts': 'import type {Payload, Options as Policy} from "unknown-alias/helpers";' },
    { 'src/external.ts': 'import type * as Lib from "./unknown";' },
    { 'src/augment.ts': 'declare module "./helpers" { interface Payload { value: string } }\nexport {};' },
  ];
  for (const extra of variants) {
    const findings = await scanProject({ ...privateApp, ...extra });
    assert.ok(!findings.some((item) => item.fix), JSON.stringify(extra));
  }
});

test('withholds export removal for merged, shadowed, unused, ambient and sole module declarations', async () => {
  for (const source of [
    'export interface Payload {}\nexport interface Payload { id: string }\nexport function run(p?: Payload) {}',
    'export type Payload = string;\nexport function run<Payload>(p?: Payload) {}',
    'export type Payload = string;\nexport function run() {}',
    'export declare interface Payload {}\nexport function run(p?: Payload) {}',
    'export type Payload = string;\nfunction run(p?: Payload) {}',
    'export interface Payload {id: string}\nconst p: Payload = {id:"x"};\nexport function run() { return p; }',
    'export interface Payload {id: string}\nexport function run() { const p: Payload = {id:"x"}; return p; }',
    'export interface Payload {id: string}\nexport interface Response { result: Payload }\nexport function run() {}',
  ]) {
    const findings = await scanProject({
      ...privateApp,
      'src/index.ts': 'import "./helpers";',
      'src/helpers.ts': source,
    });
    assert.ok(!findings.some((item) => item.fix), source);
  }
});

test('reviews direct internal function calls and primitive constants, leaving runtime APIs intact by default', async () => {
  const source = [
    'export function clamp(value: number) { return Math.min(value, 10); }',
    'export const LIMIT = 5;',
    'export function run(value: number): number { return clamp(value) < LIMIT ? 0 : 1; }',
  ].join('\n');
  const findings = await scanProject({ ...privateApp, 'src/helpers.ts': source });
  assert.equal(findings.filter((item) => item.fix?.requiresReview).length, 2);
  for (const specifier of ['../dist/helpers.js', 'unresolved-alias']) {
    const actual = await scanProject({
      ...privateApp,
      'src/helpers.ts': source,
      'job.cjs': `require('${specifier}');`,
    });
    assert.ok(!actual.some((item) => item.fix), specifier);
  }
  for (const extra of [
    'export const exposed = {clamp, LIMIT};',
    'console.log(module.exports);',
    'export function shadow(clamp: () => void, LIMIT: number) { clamp(); return LIMIT; }',
  ]) {
    const actual = await scanProject({ ...privateApp, 'src/helpers.ts': source + '\n' + extra });
    assert.ok(!actual.some((item) => item.fix), extra);
  }
});

test('reviews locally used literal products and ignores prose when checking for module reflection', async () => {
  const source = [
    '// This module and its callers require millisecond precision.',
    'export const LIFETIME = (20 * 60) * 1000;',
    'export function run(now: number) { return now + LIFETIME; }',
  ].join('\n');
  const project = { ...privateApp, 'src/helpers.ts': source };
  const [finding] = await scanProject(project);
  const fix = fixOf(finding);
  assert.equal(fix.requiresReview, true);
  assert.equal(fix.changes[0].after, 'const LIFETIME = (20 * 60) * 1000;');
  for (const usedDynamically of [
    'Reflect.ownKeys(module.exports);',
    'globalThis["eval"]("exports.LIFETIME");',
    'void import("./helpers");',
  ]) {
    const actual = await scanProject({ ...project, 'src/helpers.ts': source + '\n' + usedDynamically });
    assert.ok(!actual.some((item) => item.fix), usedDynamically);
  }
  const computed = await scanProject({ ...project, 'src/helpers.ts': source.replace('20 * 60', 'getRate() * 60') });
  assert.ok(!computed.some((item) => item.fix));
});

test('Node shebangs mark executable files as entries', async () => {
  const findings = await scanProject({
    'package.json': '{}',
    'deploy/env.cjs': '#!/usr/bin/env node\nvoid 0;',
    'deploy/flags.js': '#!/usr/bin/env -S node --no-warnings\nexport * from "./api.js";',
    'deploy/absolute.js': '#!/usr/local/bin/node\nvoid 0;',
    'deploy/api.js': 'export const ready = true;',
    'deploy/other.js': '#!/usr/bin/env node-helper\nvoid 0;',
    'deploy/comment.js': '// #!/usr/bin/env node\nvoid 0;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file deploy/comment.js', 'unreferenced-file deploy/other.js']);
});

test('a package Docker build traces a literal Node command to its copied local script', async () => {
  const findings = await scanProject({
    'package.json': '{"scripts":{"image":"docker build -f docker/Dockerfile -t worker ./backend"}}',
    'docker/Dockerfile': [
      'FROM node:22',
      'WORKDIR /app',
      'COPY package.json ./',
      'RUN npm install --omit=dev',
      'COPY tasks/report.cjs ./workers/',
      '# CMD ["node", "tasks/container-only.cjs"]',
      'CMD ["node", "./workers/report.cjs", "nightly"]',
    ].join('\n'),
    'backend/tasks/report.cjs': 'module.exports = 1;',
    'backend/tasks/container-only.cjs': 'module.exports = 2;',
    'tasks/report.cjs': 'module.exports = 3;',
  });
  assert.deepEqual(summary(findings), [
    'unreferenced-file backend/tasks/container-only.cjs',
    'unreferenced-file tasks/report.cjs',
  ]);
});

test('image entry points need a literal Node command and traceable local file', () => {
  const known = new Set(['ops/job.js']);
  const dockerfile = ['FROM node:22', 'WORKDIR /app', 'COPY ops/job.js ./'];
  const entry = (...lines: string[]) => dockerNodeEntry([...dockerfile, ...lines].join('\n'), '.', known);
  assert.equal(entry('ENTRYPOINT ["node","job.js"]'), 'ops/job.js');
  for (const lines of [
    ['CMD ["node","other.js"]'],
    ['CMD ["node","$FILE.js"]'],
    ['CMD ["node","--require","job.js"]'],
    ['CMD ["node","node_modules/pkg/job.js"]'],
    ['CMD node job.js'],
    ['ENTRYPOINT ["other"]', 'CMD ["node","job.js"]'],
    ['RUN npm install some-package', 'CMD ["node","job.js"]'],
    ['COPY --from=build /out/job.js ./', 'CMD ["node","job.js"]'],
    ['FROM node:22', 'WORKDIR /app', 'CMD ["node","job.js"]'],
  ])
    assert.equal(entry(...lines), undefined, lines.join('\n'));
  assert.equal(localDockerBuild('docker build "$CONTEXT"', '.'), undefined);
  assert.equal(localDockerBuild('docker build ../outside', '.'), undefined);
});

test('an export nothing imports and a file nothing imports are reported', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { used } from "./helpers";\nused();',
    'src/helpers.ts': 'export const used = () => 1;\nexport const unused = () => 2;',
    'src/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.ts', 'unused-export src/helpers.ts']);
  const unused = findings.find((finding) => finding.ruleId === 'unused-export');
  assert.ok(unused);
  assert.deepEqual([unused.line, unused.column], [2, 14]);
  assert.match(unused.message, /`unused`/);
});

test('type imports, namespace imports, require and literal dynamic imports count as use', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': [
      'import type { Shape } from "./types";',
      'import * as math from "./math";',
      'const legacy = require("./legacy");',
      'export const lazy = () => import("./lazy");',
      'export const shape: Shape = math.area(legacy);',
    ].join('\n'),
    'src/types.ts': 'export interface Shape { size: number }',
    'src/math.ts': 'export const area = (x) => x;\nexport const perimeter = (x) => x;',
    'src/legacy.js': 'module.exports = 1;',
    'src/lazy.ts': 'export default 1;',
  });
  assert.deepEqual(findings, []);
});

test('literal import.meta.url module URLs are referenced without consuming their exports', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': [
      'new Worker(new URL("./jobs/background.ts", import.meta.url));',
      'new SharedWorker(new URL("./jobs/shared.js", import.meta.url));',
      'new URL("./jobs/url-only.ts", import.meta.url);',
      'new Worker(new URL("./jobs/other-base.ts", configurationUrl));',
      'function localWorker(Worker) { return new Worker(new URL("./jobs/shadowed-worker.ts", import.meta.url)); }',
      'function localUrl(URL) { return new Worker(new URL("./jobs/shadowed-url.ts", import.meta.url)); }',
    ].join('\n'),
    'src/jobs/background.ts': 'self.onmessage = () => {}; export const unused = 1;',
    'src/jobs/shared.ts': 'self.onconnect = () => {};',
    'src/jobs/url-only.ts': 'export const unused = 1;',
    'src/jobs/other-base.ts': 'export const unused = 1;',
    'src/jobs/shadowed-worker.ts': 'export const unused = 1;',
    'src/jobs/shadowed-url.ts': 'export const unused = 1;',
  });
  assert.deepEqual(summary(findings), [
    'unreferenced-file src/jobs/other-base.ts',
    'unreferenced-file src/jobs/shadowed-url.ts',
    'unused-export src/jobs/background.ts',
    'unused-export src/jobs/shadowed-worker.ts',
    'unused-export src/jobs/url-only.ts',
  ]);
});

test('re-exports and export-star forward use to the original module', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { a, c } from "./barrel";\nexport const all = [a, c];',
    'src/barrel.ts': 'export { a, b as renamed } from "./one";\nexport * from "./two";',
    'src/one.ts': 'export const a = 1;\nexport const b = 2;',
    'src/two.ts': 'export const c = 3;\nexport const d = 4;',
  });
  assert.deepEqual(summary(findings), ['unused-export src/one.ts', 'unused-export src/two.ts']);
  assert.deepEqual(findings.map((finding) => finding.message.match(/`(.+?)`/)?.[1]).sort(), ['b', 'd']);
});

test('entry points and framework conventions are never reported', async () => {
  const findings = await scanProject({
    'package.json':
      '{"main":"dist/main.js","bin":{"tool":"bin/tool.js"},"scripts":{"seed":"ts-node tools/seed-data.ts"}}',
    'nest-cli.json': '{"entryFile":"worker"}',
    'src/main.ts': 'export const boot = 1;',
    'src/worker.ts': 'export const run = 1;',
    'bin/tool.js': 'module.exports = 1;',
    'tools/seed-data.ts': 'export const seed = 1;',
    'src/user.entity.ts': 'export class User {}',
    'src/users.spec.ts': 'export const fixture = 1;',
    'jest.config.ts': 'export default {};',
    'migrations/1700000000000-init.ts': 'export class Init {}',
    'pages/index.tsx': 'export default function Page() {}',
    'public/app.js': 'window.ready = true;',
    'static/widget.js': 'window.widget = 1;',
    'e2e.global-setup.ts': 'export default async function setup() {}',
    'src/orphan.service.ts': 'export class Orphan {}',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.service.ts']);
});

test('literal Node entries in GitHub workflow steps count as entry points', async () => {
  const findings = await scanProject({
    'package.json': '{}',
    '.github/workflows/integration.yml': [
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: Start integration server',
      '        run: |',
      '          # node integration/comment.js',
      '          node integration/server.js &',
      "      - run: node 'integration/inline.cjs'",
      '      - run: |-',
      '          node integration/inline-block.js',
      '      - uses: owner/action@v1',
      '        with:',
      '          run: node integration/input.js',
      '      - run: node integration/custom-cwd.js',
      '        working-directory: other',
      '      - run: node integration/chained.js && echo done',
      '  other:',
      '    defaults:',
      '      run:',
      '        working-directory: other',
      '    steps:',
      '      - run: node integration/default-cwd.js',
    ].join('\n'),
    'integration/server.js': 'module.exports = 1;',
    'integration/inline.cjs': 'module.exports = 2;',
    'integration/inline-block.js': 'module.exports = 8;',
    'integration/comment.js': 'module.exports = 3;',
    'integration/input.js': 'module.exports = 4;',
    'integration/custom-cwd.js': 'module.exports = 5;',
    'integration/chained.js': 'module.exports = 6;',
    'integration/default-cwd.js': 'module.exports = 7;',
  });
  assert.deepEqual(summary(findings), [
    'unreferenced-file integration/chained.js',
    'unreferenced-file integration/comment.js',
    'unreferenced-file integration/custom-cwd.js',
    'unreferenced-file integration/default-cwd.js',
    'unreferenced-file integration/input.js',
  ]);
});

test('operator commands run scripts without consuming their exports; documentary mentions need corroboration', async () => {
  const cli = 'launch().catch(error => { console.error(error); process.exitCode = 1; });';
  const findings = await scanProject({
    'package.json': '{}',
    'ops/RUNBOOK.md': [
      '```text',
      'node ops/launch.js --verbose',
      '# node ops/comment.js',
      'cd other',
      'node ops/different-working-directory.js',
      '```',
      '```js',
      'node ops/not-a-command.js',
      '```',
      'The runners are `ops/smoke.cjs`, `server.js` and `ops/bootstrap.js`.',
      'Older versions used `old.js` and `ops/nested.js`. Do not invoke them.',
    ].join('\n'),
    'ops/Dockerfile': 'FROM node:22\nCMD ["node","ops/server.js"]',
    'ops/compose.yaml': 'services:\n  worker:\n    command: [node, ops/bootstrap.js]',
    'ops/launch.js': 'export const neverImported = 1;',
    'ops/server.js': 'console.log("listening");',
    'ops/bootstrap.js': 'console.log("bootstrapping");',
    'ops/smoke.cjs': cli,
    'ops/undocumented.cjs': cli,
    'ops/nested.js': 'function optional() { ' + cli + ' }',
    'ops/old.js': 'export const old = 1;',
    'ops/comment.js': 'console.log(1);',
    'ops/different-working-directory.js': 'console.log(1);',
    'ops/not-a-command.js': 'console.log(2);',
  });
  assert.deepEqual(summary(findings), [
    'unreferenced-file ops/comment.js',
    'unreferenced-file ops/different-working-directory.js',
    'unreferenced-file ops/nested.js',
    'unreferenced-file ops/not-a-command.js',
    'unreferenced-file ops/old.js',
    'unreferenced-file ops/undocumented.cjs',
    'unused-export ops/launch.js',
  ]);
});

test('inventory HTML pages use literal local script entry points', async () => {
  const names = [
    'support',
    'module',
    'bare',
    'parent',
    'comment',
    'text',
    'inert',
    'inline',
    'data-attribute',
    'non-script',
    'external',
    'absolute',
    'dynamic',
    'changed-base',
  ];
  const findings = await scanProject({
    'package.json': '{}',
    'html-project/Parent Portal/page.html': [
      '<script src="./support.js"></script>',
      '<SCRIPT TYPE="module" src="module.js"></SCRIPT>',
      '<script src=bare.js></script>',
      '<script src="../js/parent.js"></script>',
      '<!-- <script src="comment.js"></script> -->',
      '<textarea><script src="text.js"></script></textarea>',
      '<template><script src="inert.js"></script></template>',
      '<script>const text = \'<script src="inline.js">\';</script>',
      '<script data-reference=\'src="data-attribute.js"\'></script>',
      '<script type="application/json" src="non-script.js"></script>',
      '<script src="https://example.invalid/external.js"></script>',
      '<script src="/absolute.js"></script>',
      '<script src="{{ dynamic }}.js"></script>',
    ].join('\n'),
    'html-project/Parent Portal/changed-base.html': [
      '<base href="/different-folder/">',
      '<script src="changed-base.js"></script>',
    ].join('\n'),
    ...Object.fromEntries(
      names.map((name) => [
        name === 'parent' ? 'html-project/js/parent.js' : `html-project/Parent Portal/${name}.js`,
        'const loaded = true;',
      ]),
    ),
  });
  assert.deepEqual(
    summary(findings),
    names
      .slice(4)
      .sort()
      .map((name) => `unreferenced-file html-project/Parent Portal/${name}.js`),
  );
});

test('a non-literal dynamic import makes findings contextual', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'export const load = (name) => import(name);',
    'src/orphan.ts': 'export const lonely = 1;',
  });
  assert.equal(findings.length, 1);
  assert.match(reasonOf(findings[0]), /non-literal/);
});

test('a dynamic import with a relative prefix only affects that folder', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'export const load = (name) => import(`./locales/${name}`);',
    'src/locales/en.ts': 'export const messages = {};',
    'src/other/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(
    findings.map((finding) => [finding.file, Boolean(finding.contextualReason)]),
    [
      ['src/locales/en.ts', true],
      ['src/other/orphan.ts', false],
    ],
  );
});

test('declaration files count as users and are not reported themselves', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'export const entry = 1;',
    'src/shapes.ts': 'export interface Shape { size: number }\nexport interface Unused { id: number }',
    'src/globals.d.ts': 'import type { Shape } from "./shapes";\ndeclare global { var shape: Shape }\nexport {};',
    'src/lazy.ts': 'export const lazy = 1;',
    'src/lazy-types.d.ts': 'declare const lazyValue: import("./lazy").lazy;\nexport { lazyValue };',
    'src/augment.ts': 'export interface Options { debug: boolean }',
    'src/augment.d.ts': 'declare module "./augment" { interface Options { extra: boolean } }',
    'src/legacy.ts': 'export const legacy = 1;',
    'src/refs.d.ts': '/// <reference path="./legacy.ts" />',
  });
  assert.deepEqual(summary(findings), ['unused-export src/shapes.ts']);
  assert.match(findings[0].message, /`Unused`/);
});

test('a package.json exports wildcard publishes every file it matches', async () => {
  const findings = await scanProject({
    'package.json': '{"exports":{".":"./src/index.ts","./features/*":"./src/features/*.ts"}}',
    'src/index.ts': 'export const entry = 1;',
    'src/features/billing.ts': 'export const billing = 1;',
    'src/features/auth.ts': 'export const auth = 1;',
    'src/internal/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/internal/orphan.ts']);
});

test('every wildcard in an export target uses the same subpath, including build-to-source paths', async () => {
  const findings = await scanProject({
    'package.json': '{"exports":{"./features/*":"./dist/features/*/load-*.js"}}',
    'src/features/orders/load-orders.ts': 'export const load = 1;',
    'src/features/orders/load-other.ts': 'export const other = 2;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/features/orders/load-other.ts']);
});
