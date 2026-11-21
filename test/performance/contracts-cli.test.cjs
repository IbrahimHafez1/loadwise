'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');

const BIN = path.join(__dirname, '..', '..', 'bin', 'loadwise.cjs');

function git(root, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
}

function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}

// A repository whose first commit holds `before`; `after` is then written to the working tree, uncommitted.
function repository(context, before, after) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-contracts-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  for (const [name, text] of Object.entries(before)) write(root, name, text);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'old');
  for (const [name, text] of Object.entries(after)) write(root, name, text);
  return root;
}

function contracts(root, ...args) {
  const run = spawnSync(process.execPath, [BIN, 'perf', 'contracts', '--changed-since', 'HEAD', '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: run.status, stderr: run.stderr, report: run.stdout ? JSON.parse(run.stdout) : null };
}

const ruleLines = ({ report }) => report.findings.map(({ ruleId, file }) => `${ruleId} ${file}`).sort();

function openApi(overrides = {}) {
  return JSON.stringify(
    {
      openapi: '3.0.0',
      paths: {
        '/users': {
          get: {
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
              },
            },
          },
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } },
            },
            responses: { 201: { description: 'created' } },
          },
          delete: { responses: { 204: { description: 'gone' } } },
        },
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } },
          NewUser: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string' }, role: { type: 'string', enum: ['admin', 'member'] } },
          },
        },
      },
      ...overrides,
    },
    null,
    2,
  );
}

describe('loadwise perf contracts: OpenAPI', () => {
  test('flags removed operations, response fields, new required inputs, type changes and removed enum values', (context) => {
    const next = JSON.parse(openApi());
    delete next.paths['/users'].delete;
    delete next.components.schemas.User.properties.email;
    next.components.schemas.NewUser.required.push('role');
    next.components.schemas.NewUser.properties.role.enum = ['member'];
    next.paths['/users'].get.parameters[0].schema.type = 'string';
    const root = repository(context, { 'openapi.json': openApi() }, { 'openapi.json': JSON.stringify(next, null, 2) });
    const run = contracts(root);
    assert.equal(run.code, 1);
    assert.deepEqual(ruleLines(run), [
      'api-enum-value-removed openapi.json',
      'api-removed-field openapi.json',
      'api-removed-operation openapi.json',
      'api-required-input openapi.json',
      'api-type-changed openapi.json',
    ]);
    const removed = run.report.findings.find(({ ruleId }) => ruleId === 'api-removed-operation');
    assert.match(removed.message, /DELETE \/users was removed\. Clients that call it get 404 or 405/);
    assert.match(removed.id, /^[0-9a-f]{12}$/);
  });

  test('adding a /v2 next to a kept /v1 is not breaking', (context) => {
    const next = JSON.parse(openApi());
    next.paths['/v2/users'] = structuredClone(next.paths['/users']);
    next.paths['/v2/users'].get.responses[200].content['application/json'].schema = { type: 'object', properties: {} };
    const root = repository(context, { 'openapi.json': openApi() }, { 'openapi.json': JSON.stringify(next) });
    const run = contracts(root);
    assert.equal(run.code, 0);
    assert.deepEqual(run.report.findings, []);
  });

  test('additive changes pass, and YAML documents are skipped with a note', (context) => {
    const next = JSON.parse(openApi());
    next.components.schemas.User.properties.name = { type: 'string' };
    next.components.schemas.NewUser.properties.nickname = { type: 'string' };
    const root = repository(
      context,
      { 'openapi.json': openApi(), 'openapi.yaml': 'openapi: 3.0.0\n' },
      { 'openapi.json': JSON.stringify(next), 'openapi.yaml': 'openapi: 3.0.1\n' },
    );
    const run = contracts(root);
    assert.equal(run.code, 0);
    assert.match(run.stderr, /Skipped openapi\.yaml: YAML OpenAPI documents are not compared/);
  });
});

describe('loadwise perf contracts: GraphQL SDL', () => {
  const oldSchema = `
    "A user"
    type Query {
      user(id: ID!, verbose: Boolean = false): User
      users: [User!]!
    }
    type Mutation { rename(id: ID!, name: String): User }
    type User { id: ID! name: String! legacy: String }
    input Filter { name: String }
    enum Role { ADMIN MEMBER }
  `;

  test('flags removed operations, fields and enum values, required arguments and narrowed types', (context) => {
    const newSchema = `
      type Query {
        user(id: ID!, verbose: Boolean = false, tenant: ID!): User
      }
      type Mutation { rename(id: ID!, name: String!): User }
      type User { id: ID! name: String legacy: String! }
      input Filter { name: String! }
      enum Role { MEMBER }
    `;
    const root = repository(context, { 'schema.graphql': oldSchema }, { 'schema.graphql': newSchema });
    const run = contracts(root);
    const byRule = (ruleId) => run.report.findings.filter((finding) => finding.ruleId === ruleId).map((f) => f.message);
    assert.equal(run.code, 1);
    assert.match(byRule('api-removed-operation').join(), /Operation Query\.users was removed/);
    assert.match(byRule('api-enum-value-removed').join(), /Role\.ADMIN/);
    assert.equal(byRule('api-required-input').length, 3);
    assert.match(byRule('api-required-input').join('\n'), /Argument Query\.user\(tenant\) is new and non-null/);
    assert.match(byRule('api-required-input').join('\n'), /Input field Filter\.name changed from String to String!/);
    assert.match(byRule('api-type-changed').join('\n'), /Field User\.name changed from String! to String/);
    assert.equal(
      run.report.findings.some(({ line }) => line < 1),
      false,
    );
  });

  test('safe changes pass: new optional arguments, new fields, stricter output types', (context) => {
    const newSchema = oldSchema
      .replace('users: [User!]!', 'users(first: Int): [User!]!')
      .replace('legacy: String', 'legacy: String! extra: Int')
      .replace('enum Role { ADMIN MEMBER }', 'enum Role { ADMIN MEMBER GUEST }');
    const root = repository(context, { 'schema.graphql': oldSchema }, { 'schema.graphql': newSchema });
    assert.deepEqual(contracts(root).report.findings, []);
  });

  test('query documents are skipped quietly instead of misread', (context) => {
    const root = repository(context, { 'ops.graphql': 'query A { me { id } }' }, { 'ops.graphql': 'query A { me }' });
    const run = contracts(root);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, '');
  });
});

describe('loadwise perf contracts: NestJS DTOs', () => {
  const controller = `
    import { Body, Controller, Get, Post } from '@nestjs/common';
    import { CreateUserDto, UserDto } from './dto';
    @Controller('users')
    export class UsersController {
      @Post() create(@Body() body: CreateUserDto): Promise<UserDto> { return null as never; }
      @Get() list(): Promise<UserDto[]> { return null as never; }
    }
  `;
  const oldDto = `
    export class CreateUserDto { email: string; nickname?: string; role: 'a' | 'b'; }
    export class UserDto { id: string; email: string; age: number; }
  `;

  test('flags removed output properties, new required inputs, type changes and removed literals', (context) => {
    const newDto = `
      export class CreateUserDto { email: string; nickname: string; phone: string; role: 'a'; }
      export class UserDto { id: string; age: string; }
    `;
    const root = repository(
      context,
      { 'src/users.controller.ts': controller, 'src/dto.ts': oldDto },
      { 'src/dto.ts': newDto },
    );
    const run = contracts(root);
    assert.equal(run.code, 1);
    const messages = run.report.findings.map(({ ruleId, message }) => `${ruleId}: ${message}`).join('\n');
    assert.match(messages, /api-removed-field: Response property UserDto\.email was removed/);
    assert.match(messages, /api-required-input: Request property CreateUserDto\.nickname is now required/);
    assert.match(messages, /api-required-input: Request property CreateUserDto\.phone is new and required/);
    assert.match(messages, /api-enum-value-removed: Request property CreateUserDto\.role no longer accepts 'b'/);
    assert.match(messages, /api-type-changed: Property UserDto\.age changed type from number to string/);
    assert.equal(run.report.findings.length, 5);
    assert.ok(run.report.findings.every(({ file }) => file === 'src/dto.ts'));
  });

  test('optional additions, optional decorators, unused classes and unchanged DTOs are quiet', (context) => {
    const newDto = `
      export class CreateUserDto { email: string; @IsOptional() nickname: string; role: 'a' | 'b'; extra?: number; }
      export class UserDto { id: string; email: string; age: number; added: string; }
      export class Unused { gone: string; }
    `;
    const root = repository(
      context,
      {
        'src/users.controller.ts': controller,
        'src/dto.ts': oldDto + 'export class Unused { gone: string; kept: string; }',
      },
      { 'src/dto.ts': newDto },
    );
    assert.deepEqual(contracts(root).report.findings, []);
  });
});

describe('loadwise perf contracts: DTO unknown input and inheritance', () => {
  const controller = `
    import { Body, Controller, Post } from '@nestjs/common';
    import { CreateDto } from './dto';
    @Controller('x')
    export class XController {
      @Post() create(@Body() body: CreateDto): void {}
    }
  `;
  const oldDto = 'export class CreateDto { name: string; note?: string; }';
  const newDto = 'export class CreateDto { name: string; }';
  const strictMain = 'app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));';

  test('a removed request property is breaking when ValidationPipe forbids unknown properties', (context) => {
    const root = repository(
      context,
      { 'src/x.controller.ts': controller, 'src/dto.ts': oldDto, 'src/main.ts': strictMain },
      { 'src/dto.ts': newDto },
    );
    const run = contracts(root);
    assert.equal(run.code, 1);
    assert.deepEqual(ruleLines(run), ['api-removed-field src/dto.ts']);
    assert.match(run.report.findings[0].message, /CreateDto\.note was removed .*now get a 400 response/);
  });

  test('without forbidNonWhitelisted a removed request property is not flagged', (context) => {
    const lenient = 'app.useGlobalPipes(new ValidationPipe({ whitelist: true }));';
    const root = repository(
      context,
      { 'src/x.controller.ts': controller, 'src/dto.ts': oldDto, 'src/main.ts': lenient },
      { 'src/dto.ts': newDto },
    );
    assert.deepEqual(contracts(root).report.findings, []);
  });

  test('properties inherited from a base class in a relative import are compared', (context) => {
    const files = {
      'src/x.controller.ts': controller.replace('./dto', './child'),
      'src/base.ts': 'export class Base { id: string; age: number; }',
      'src/child.ts': "import { Base } from './base';\nexport class CreateDto extends Base { name: string; }",
    };
    const root = repository(context, files, { 'src/base.ts': 'export class Base { age: string; extra: string; }' });
    const messages = contracts(root).report.findings.map(({ message }) => message);
    assert.equal(messages.length, 2);
    assert.match(messages.join('\n'), /Property CreateDto\.age changed type from number to string/);
    assert.match(messages.join('\n'), /CreateDto\.extra is new and required/);
  });
});

describe('loadwise perf contracts: command line and check', () => {
  test('an unresolvable ref exits 2 with a hint', (context) => {
    const root = repository(context, { 'a.txt': 'x' }, {});
    const run = spawnSync(process.execPath, [BIN, 'perf', 'contracts', '--changed-since', 'no-such-ref'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Cannot resolve git ref `no-such-ref`/);
  });

  test('text output names the file, rule and line; a clean tree prints a zero count', (context) => {
    const next = JSON.parse(openApi());
    delete next.paths['/users'].delete;
    const root = repository(context, { 'openapi.json': openApi() }, { 'openapi.json': JSON.stringify(next, null, 2) });
    const run = spawnSync(process.execPath, [BIN, 'perf', 'contracts', '--changed-since', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(
      run.stdout,
      /^openapi\.json:\d+:\d+ \[api-removed-operation #[0-9a-f]{12}\] Operation DELETE \/users/m,
    );
    assert.match(run.stdout, /1 file\(s\) compared, 1 breaking change\(s\)\./);
  });

  test('check --changed-since adds contract findings to the performance report', (context) => {
    const next = JSON.parse(openApi());
    delete next.paths['/users'].delete;
    const root = repository(
      context,
      { 'openapi.json': openApi(), 'tsconfig.json': '{"include":["*.ts"]}', 'a.ts': 'export const a = 1;\n' },
      { 'openapi.json': JSON.stringify(next, null, 2) },
    );
    const run = spawnSync(process.execPath, [BIN, 'check', '--changed-since', 'HEAD', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(
      report.performance.findings.map(({ ruleId }) => ruleId),
      ['api-removed-operation'],
    );
  });

  test('check reports child project contracts relative to the invoking directory in every format', (context) => {
    const child = 'services/api';
    const contract = `${child}/openapi.json`;
    const next = JSON.parse(openApi());
    delete next.paths['/users'].delete;
    const root = repository(
      context,
      {
        [contract]: openApi(),
        [`${child}/tsconfig.json`]: '{"include":["*.ts"]}',
        [`${child}/a.ts`]: 'export const answer = 1;\n',
      },
      { [contract]: JSON.stringify(next, null, 2) },
    );
    const direct = contracts(path.join(root, child));
    assert.equal(direct.code, 1, direct.stderr);
    const [finding] = direct.report.findings;
    assert.equal(finding.file, 'openapi.json');

    function check(...args) {
      const run = spawnSync(process.execPath, [BIN, 'check', child, '--changed-since', 'HEAD', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(run.status, 1, run.stderr);
      return run.stdout;
    }

    const report = JSON.parse(check('--json'));
    assert.deepEqual(report.performance.findings, [{ ...finding, file: contract }]);
    const sarif = JSON.parse(check('--format', 'sarif'));
    const [result] = sarif.runs[0].results;
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, contract);
    assert.match(check(), /^services\/api\/openapi\.json:\d+:\d+ /m);
  });

  test('combined source checkers still compare API contracts in a project without a TS config', (context) => {
    const next = JSON.parse(openApi());
    delete next.paths['/users'].delete;
    const root = repository(context, { 'openapi.json': openApi() }, { 'openapi.json': JSON.stringify(next, null, 2) });
    const run = spawnSync(process.execPath, [BIN, 'check', '--only', 'perf,sec', '--changed-since', 'HEAD', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, run.stderr);
    const { performance, security } = JSON.parse(run.stdout);
    assert.equal(performance.findings[0].ruleId, 'api-removed-operation');
    assert.equal(security, null);
  });
});
