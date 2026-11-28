// nosql-operator-injection: object-capable request data as a Mongo filter or filter value; strings,
// `$eq` wrappers, route parameters and operator objects the code built itself are silent. The fix
// wraps values in `$eq`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.js';
import { scanWithFixes, requireFix, withSecurity } from '../performance/site-fix-helpers.js';
import type { LocatedFinding } from '../types/security.js';

const ruleId = 'nosql-operator-injection';
const mongoose = {
  'node_modules/mongoose/index.d.ts': [
    'export interface Model<T> { find(filter?: object): unknown; findOne(filter?: object): unknown;',
    '  distinct(field: string, filter?: object): unknown; aggregate(pipeline: object[]): unknown }',
    'export declare function model<T>(name: string, schema?: unknown): Model<T>;',
    'declare const mongoose: { model: typeof model }; export default mongoose;',
  ].join('\n'),
};
const userModel = {
  'models/user.ts': "import mongoose from 'mongoose';\nexport const User = mongoose.model('User', {});",
};
const packages = { ...stubs.express, ...stubs.nest, ...mongoose, ...userModel };

function route(...body: string[]) {
  return [
    "import express from 'express';",
    "import { User } from './models/user';",
    'const app = express();',
    "app.post('/login', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function nosqlLines(source: string, files = packages) {
  const { typed } = lintBothWays(source, files);
  return typed
    .filter((finding: LocatedFinding) => finding.ruleId === ruleId)
    .map((finding: LocatedFinding) => [finding.line, finding.contextualReason ? 'C' : 'D']);
}

test('body and query values used as filter values, whole filters and $match stages are reported', () => {
  const source = route(
    'User.findOne({ email: req.body.email, password: req.body.password });',
    'const { token } = req.body;',
    'User.findOne({ token });',
    'User.find(req.query);',
    'User.find({ ...req.body, active: true });',
    'User.aggregate([{ $match: { name: req.body.name } }]);',
    'User.distinct("email", { $or: [{ team: req.body.team }] });',
  );
  assert.deepEqual(nosqlLines(source), [
    [5, 'D'],
    [5, 'D'],
    [7, 'D'],
    [8, 'D'],
    [9, 'D'],
    [10, 'D'],
    [11, 'D'],
  ]);
  const first = lintWithoutTypes(source, packages).find((finding: LocatedFinding) => finding.ruleId === ruleId);
  assert.ok(first);
  assert.equal(
    first.message,
    '`req.body.email` is used as a MongoDB filter value and can be an object such as `{ "$ne": null }`, changing what the query matches. Pass `String(value)` or wrap it as `{ $eq: value }`, or validate the body with a schema.',
  );
});

test('a $where expression built from the request is reported with its own message', () => {
  const source = route("User.find({ $where: `this.name === '${req.body.name}'` });");
  const finding = lintBothWays(source, packages).typed.find((entry) => entry.ruleId === ruleId);
  assert.ok(finding);
  assert.match(finding.message, /`\$where` expression, which runs as JavaScript/);
});

test('strings, $eq wrappers, route parameters, string methods and operator objects built here are silent', () => {
  const source = route(
    'User.findOne({ email: String(req.body.email) });',
    'User.findOne({ email: `${req.body.email}` });',
    'User.findOne({ email: { $eq: req.body.email } });',
    'User.findOne({ _id: req.params.id });',
    'User.findOne({ email: req.body.email.toLowerCase() });',
    'const ids = [req.body.first, req.body.second];',
    'const category = req.query.one ? "fixed" : { $in: ids };',
    'User.find({ category });',
    'User.find(req.params);',
    'cache.find({ key: req.body.key });',
  );
  assert.deepEqual(nosqlLines(source.replace('const app', 'declare const cache: any;\nconst app')), []);
});

test('nest models: a whole query DTO is reported, a declared string DTO field is not', () => {
  const source = [
    "import { Body, Controller, Get, Query } from '@nestjs/common';",
    "import { Model } from 'mongoose';",
    'class LoginDto { email!: string }',
    '@Controller() class Users {',
    '  constructor(private readonly users: Model<unknown>) {}',
    '  @Get() list(@Query() query: Record<string, unknown>) { return this.users.find(query); }',
    '  @Get() login(@Body() body: LoginDto) { return this.users.findOne({ email: body.email }); }',
    '}',
  ].join('\n');
  assert.deepEqual(nosqlLines(source), [[6, 'D']]);
});

test('a request value passed to a service is reported in the service', () => {
  const source = [
    "import express from 'express';",
    "import { User } from './models/user';",
    'function byFilter(filter: any) { return User.findOne({ owner: filter }); }',
    'const app = express();',
    "app.post('/x', (req, res) => byFilter(req.body.owner));",
  ].join('\n');
  assert.deepEqual(nosqlLines(source), [[3, 'D']]);
});

test('the $eq fix wraps a filter value and a shorthand property, and the fixed code is clean', (context) => {
  const source = route(
    'User.findOne({ email: req.body.email });',
    'const { token } = req.body;',
    'User.findOne({ token });',
  );
  const files = {
    'src.ts': source.replace("'./models/user'", "'./models/user.js'"),
    'models/user.ts': userModel['models/user.ts'],
    ...stubs.express,
    ...mongoose,
  };
  const { root, findings } = scanWithFixes(context, files, { analyzers: withSecurity });
  const fixed = findings.filter((finding) => finding.ruleId === ruleId);
  assert.deepEqual(
    fixed.map((finding) => finding.fix?.changes[0].after.trim()),
    ['User.findOne({ email: { $eq: req.body.email } });', 'User.findOne({ token: { $eq: token } });'],
  );
  let text = fs.readFileSync(path.join(root, 'src.ts'), 'utf8');
  for (const finding of fixed) {
    const { before, after } = requireFix(finding).changes[0];
    text = text.replace(before, after);
  }
  fs.writeFileSync(path.join(root, 'src.ts'), text);
  const again = scanWithFixes(context, { ...files, 'src.ts': text }, { analyzers: withSecurity });
  assert.deepEqual(
    again.findings.filter((finding) => finding.ruleId === ruleId),
    [],
  );
});

test('only registered Express middleware makes a NoSQL finding contextual', (context) => {
  const files = {
    'src.ts': route('User.find(req.query);').replace("'./models/user'", "'./models/user.js'"),
    'models/user.ts': userModel['models/user.ts'],
    'package.json': JSON.stringify({ dependencies: { 'express-mongo-sanitize': '^2.2.0' } }),
    ...stubs.express,
    ...mongoose,
  };
  function reason(setup: string) {
    const { findings } = scanWithFixes(context, { ...files, 'setup.ts': setup }, { analyzers: withSecurity });
    const found = findings.find((finding) => finding.ruleId === ruleId);
    assert.ok(found);
    return found.contextualReason;
  }
  const setup = [
    "import express from 'express';",
    "import sanitize from 'express-mongo-sanitize';",
    'const app = express();',
  ].join('\n');
  assert.equal(reason(setup), undefined);
  assert.equal(
    reason(setup + '\nconst unrelated = { use(callback: unknown) {} };\nunrelated.use(sanitize());'),
    undefined,
  );
  assert.equal(reason(setup + '\napp.use(sanitize.sanitize({}));'), undefined);
  assert.match(reason(setup + '\napp.use(sanitize());') ?? '', /express-mongo-sanitize/);
});

test('operator-key values, spread nested objects, local filters and pipelines, where values and $or branches are reported', () => {
  const source = route(
    'User.find({ $or: req.body.branches });',
    'User.find({ profile: { ...req.body } });',
    'const pipeline = [{ $match: { name: req.body.name } }];',
    'User.aggregate(pipeline);',
    'const filter = { name: req.body.name };',
    'User.find(filter);',
    'User.where("name", req.body.name);',
    'User.find({ $or: [req.body, { active: true }] });',
  );
  assert.deepEqual(nosqlLines(source), [
    [5, 'D'],
    [6, 'D'],
    [7, 'D'],
    [9, 'D'],
    [11, 'D'],
    [12, 'D'],
  ]);
});

test('an exact nested sub-document match and a computed key are silent', () => {
  const source = route('User.find({ profile: { name: req.body.name } });', 'User.find({ [req.body.field]: true });');
  assert.deepEqual(nosqlLines(source), []);
});

test('later filter writes, pushed pipeline stages, local $or branches and where spreads are reported', () => {
  const source = route(
    'const filter: Record<string, unknown> = {};',
    'filter.$where = req.body.code;',
    'User.find(filter);',
    'const pipeline: object[] = [];',
    'pipeline.push({ $match: { name: req.body.name } });',
    'User.aggregate(pipeline);',
    'const branch = { name: req.body.name };',
    'User.find({ $or: [branch] });',
    'User.where("name", { ...req.body });',
    'User.where("name", { $eq: req.body.name });',
  );
  assert.deepEqual(nosqlLines(source), [
    [6, 'D'],
    [9, 'D'],
    [11, 'D'],
    [13, 'D'],
  ]);
});

test('a stage pushed after aggregate runs is silent unless a loop runs the call again', () => {
  const source = route(
    'const pipeline: object[] = [];',
    'User.aggregate(pipeline);',
    'pipeline.push({ $match: { name: req.body.name } });',
    'const looped: object[] = [];',
    'for (const name of req.body.names) {',
    '  User.aggregate(looped);',
    '  looped.push({ $match: { name } });',
    '}',
  );
  assert.deepEqual(nosqlLines(source), [[11, 'D']]);
});

test('a stage pushed in an outer loop reaches an aggregate inside an inner loop', () => {
  const source = route(
    'const pipeline: object[] = [];',
    'for (let outer = 0; outer < 2; outer++) {',
    '  for (let inner = 0; inner < 1; inner++) {',
    '    User.aggregate(pipeline);',
    '  }',
    '  pipeline.push({ $match: { name: req.body.name } });',
    '}',
  );
  assert.deepEqual(nosqlLines(source), [[10, 'D']]);
});

test('a field written to a local $or branch is reported, an $eq-wrapped one is silent', () => {
  const source = route(
    'const branch: Record<string, unknown> = {};',
    'branch.name = req.body.name;',
    'User.find({ $or: [branch] });',
    'const wrapped: Record<string, unknown> = {};',
    'wrapped.name = { $eq: req.body.name };',
    'User.find({ $or: [wrapped] });',
  );
  assert.deepEqual(nosqlLines(source), [[6, 'D']]);
});
