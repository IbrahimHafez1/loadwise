import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import { reasonOf } from '../types/finding-reason.js';
// Loaded on use: these helpers load the bundled compiler, which the native engine run must not.
const loadedFixHelpers = process.env.PERF_CHECK_TEST_NATIVE === '1' ? undefined : await import('./site-fix-helpers.js');
const fixHelpers = () => {
  assert.ok(loadedFixHelpers, 'site-fix-helpers requires the bundled compiler');
  return loadedFixHelpers;
};

const ROUTE_RULE = 'async-route-unhandled-rejection';
const CALLBACK_RULE = 'async-callback-unhandled-rejection';
// Fix and package.json tests scan real files on the bundled compiler, which cannot share a process
// with the native one.
const onBundledEngine = { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' };
const header = 'declare const app: any;\ndeclare function load(): Promise<string>;\n';

function manifest(expressRange: string) {
  return JSON.stringify({ name: 'fixture', dependencies: { express: expressRange } });
}

interface ScanOptions {
  express?: string;
  extra?: FileMap;
}

function scan(context: TestContext, source: string, { express = '^4.18.2', extra = {} }: ScanOptions = {}) {
  const files: FileMap = { 'app.ts': header + source, ...extra };
  if (express) files['package.json'] = manifest(express);
  return fixHelpers().scanWithFixes(context, files).findings;
}

function routeFindings(context: TestContext, source: string, options?: ScanOptions) {
  return scan(context, source, options).filter((finding) => finding.ruleId === ROUTE_RULE);
}

// Virtual files have no package.json, so the Express version is unknown and route findings are
// contextual.
function lintedRouteFindings(source: string) {
  return lint(header + source).filter((finding: Finding) => finding.ruleId === ROUTE_RULE);
}

function callbackFindings(source: string) {
  return lint(header + source).filter((finding: Finding) => finding.ruleId === CALLBACK_RULE);
}

const unguardedRoute = `app.get('/users', async (req, res) => {
  const users = await load();
  res.json(users);
});
`;

test('reports an Express 4 async route handler without try/catch or next', onBundledEngine, (context) => {
  const findings = routeFindings(context, unguardedRoute);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].contextualReason, undefined);
  assert.match(findings[0].message, /next\(error\)/);
});

test('reports router.use and handlers after middleware arguments', () => {
  const findings = lintedRouteFindings(
    `declare const router: any;
declare const auth: any;
router.use(async (req, res) => {
  await load();
});
router.post('/x', auth, async function (request, response) {
  response.send(await load());
});
`,
  );
  assert.equal(findings.length, 2);
});

test('stays silent on Express 5', onBundledEngine, (context) => {
  assert.equal(routeFindings(context, unguardedRoute, { express: '^5.0.1' }).length, 0);
});

test('an unknown Express version is a contextual finding', () => {
  const findings = lintedRouteFindings(unguardedRoute);
  assert.equal(findings.length, 1);
  assert.match(reasonOf(findings[0]), /Express version/);
});

test('ignores guarded, next-taking, await-free and wrapped handlers', () => {
  const findings = lintedRouteFindings(
    `declare function asyncHandler(fn: any): any;
app.get('/a', async (req, res) => {
  try {
    res.json(await load());
  } catch (error) {
    res.status(500).end();
  }
});
app.get('/b', async (req, res, next) => {
  res.json(await load());
});
app.get('/c', async (req, res) => {
  res.json({ ok: true });
});
app.get('/d', asyncHandler(async (req, res) => {
  res.json(await load());
}));
app.get('/e', async (req, res) => {
  res.json(await load().catch(() => []));
});
app.get('/f', async (ctx) => {
  ctx.body = await load();
});
`,
  );
  assert.deepEqual(findings, []);
});

test('stays silent when express-async-errors is imported anywhere in the program', onBundledEngine, (context) => {
  const findings = routeFindings(context, unguardedRoute, {
    extra: { 'server.ts': "import 'express-async-errors';\nexport {};\n" },
  });
  assert.equal(findings.length, 0);
});

test('the route fix adds next and forwards the error', onBundledEngine, (context) => {
  const [finding] = routeFindings(context, unguardedRoute);
  assert.equal(fixHelpers().requireFix(finding).requiresReview, true);
  const { before, after } = fixHelpers().requireOnlyChange(finding);
  assert.equal(before, "app.get('/users', async (req, res) => {\n  const users = await load();\n  res.json(users);");
  assert.equal(
    after,
    [
      "app.get('/users', async (req, res, next) => {",
      '  try {',
      '    const users = await load();',
      '    res.json(users);',
      '  } catch (error) {',
      '    next(error);',
      '  }',
    ].join('\n'),
  );
});

test('reports async callbacks given to emitters, timers, nextTick and cron', () => {
  const findings = callbackFindings(`declare const socket: any;
declare const cron: any;
socket.on('message', async (message: string) => {
  await load();
});
setTimeout(async () => {
  await load();
}, 1000);
process.nextTick(async () => {
  await load();
});
cron.schedule('* * * * *', async () => {
  for await (const line of [load()]) console.log(line);
});
`);
  assert.equal(findings.length, 4);
});

test('ignores guarded, await-free and non-async callbacks', () => {
  const findings = callbackFindings(`declare const emitter: any;
emitter.on('a', async () => {
  try {
    await load();
  } catch (error) {
    console.error(error);
  }
});
emitter.once('b', async () => {
  console.log('no await');
});
setInterval(() => {
  load().catch(console.error);
}, 1000);
emitter.on('c', async () => {
  const run = async () => await load();
  run().catch(console.error);
});
`);
  assert.deepEqual(findings, []);
});

test('ignores a worker thread message handler, whose crash the parent receives as an error event', () => {
  const worker = `declare const require: any;
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async () => {
  await load();
});
`;
  assert.deepEqual(callbackFindings(worker), []);
  const unrelated = `declare const parentPort: any;
parentPort.on('message', async () => {
  await load();
});
`;
  assert.equal(callbackFindings(unrelated).length, 1);
});

test('the callback fix logs with console.error, or logger when the file has one', onBundledEngine, (context) => {
  const source = `setTimeout(async () => {
  await load();
}, 1000);
`;
  const [plain] = scan(context, source).filter((finding) => finding.ruleId === CALLBACK_RULE);
  assert.equal(fixHelpers().requireFix(plain).requiresReview, true);
  assert.equal(
    fixHelpers().requireOnlyChange(plain).after,
    ['try {', '  await load();', '} catch (error) {', '  console.error(error);', '}'].join('\n'),
  );
  const [logged] = scan(context, 'declare const logger: any;\n' + source).filter(
    (finding) => finding.ruleId === CALLBACK_RULE,
  );
  assert.match(fixHelpers().requireOnlyChange(logged).after, /logger\.error\(error\);/);
});
