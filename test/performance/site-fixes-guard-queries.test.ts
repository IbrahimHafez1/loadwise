import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanWithFixes, dedent, requireFix } from './site-fix-helpers.js';
import type { TestContext } from 'node:test';
import type { FixChange } from '../../lib/shared/types.js';

const RULE_ID = 'guard-query-per-request';
const packages = {
  'node_modules/@nestjs/common/index.d.ts': `export interface CanActivate { canActivate(context: unknown): boolean | Promise<boolean>; }
    export declare function Injectable(): ClassDecorator;
    export declare const APP_GUARD: string;`,
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      findOne(options?: object): Promise<T | null>;
      findOneBy(filter: object): Promise<T | null>;
    }`,
};
const guard = (lookup: string) => `import { CanActivate, Injectable, APP_GUARD } from '@nestjs/common';
import { Repository } from 'typeorm';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly users: Repository<{ id: number; active: boolean }>) {}

  private ready(context: { ids: number[] }) {
    return context.ids.length > 0;
  }

  async canActivate(context: { userId: number; ids: number[] }) {
    if (!this.ready(context)) return false;
    ${lookup}
    return Boolean(user?.active);
  }

  private describe() {
    return 'session';
  }
}
export const providers = [{ provide: APP_GUARD, useClass: SessionGuard }];
`;

function scan(context: TestContext, source: string) {
  const { findings } = scanWithFixes(context, { ...packages, 'guard.ts': source });
  return findings.filter((finding) => finding.ruleId === RULE_ID);
}

test('a guard lookup by id is wrapped in a per-instance TTL cache added to the class', (context) => {
  const [finding, ...rest] = scan(
    context,
    guard('const user = await this.users.findOne({ where: { id: context.userId }, select: { active: true } });'),
  );
  assert.equal(rest.length, 0);
  const changes = requireFix(finding).changes.map((change: FixChange) => ({
    before: dedent(change.before),
    after: dedent(change.after),
  }));
  assert.deepEqual(changes, [
    {
      before: 'constructor(private readonly users: Repository<{ id: number; active: boolean }>) {}',
      after: [
        '// Guards run on every request, so this lookup is reused for a few seconds.',
        'private readonly usersLookupCache = new Map<string, { expiresAt: number; value: unknown }>();',
        'private readonly usersLookupTtlMs = 30_000;',
        'private readonly usersLookupMaxEntries = 10_000;',
        '',
        'constructor(private readonly users: Repository<{ id: number; active: boolean }>) {}',
      ].join('\n'),
    },
    {
      before: 'const user = await this.users.findOne({ where: { id: context.userId }, select: { active: true } });',
      after:
        'const user = await this.getOrLoadUsers(`${context.userId}`, () => this.users.findOne({ where: { id: context.userId }, select: { active: true } }));',
    },
    {
      before: '}',
      after: [
        '',
        '  private async getOrLoadUsers<T>(key: string, load: () => Promise<T>): Promise<T> {',
        '    const cached = this.usersLookupCache.get(key);',
        '    if (cached && cached.expiresAt > Date.now()) return cached.value as T;',
        '    const value = await load();',
        '    if (value === null || value === undefined) return value;',
        '    if (this.usersLookupCache.size >= this.usersLookupMaxEntries) this.usersLookupCache.clear();',
        '    this.usersLookupCache.set(key, { expiresAt: Date.now() + this.usersLookupTtlMs, value });',
        '    return value;',
        '  }',
        '}',
      ].join('\n'),
    },
  ]);
  assert.match(
    requireFix(finding).note ?? '',
    /only after the TTL.*clear `this\.usersLookupCache`.*lower `usersLookupTtlMs`/s,
  );
});

test('findOneBy keys on the variable filter values only', (context) => {
  const [finding] = scan(
    context,
    guard('const user = await this.users.findOneBy({ id: context.userId, active: true });'),
  );
  assert.match(
    requireFix(finding).changes[1].after,
    /this\.getOrLoadUsers\(`\$\{context\.userId\}`, \(\) => this\.users\.findOneBy\(\{ id: context\.userId, active: true \}\)\)/,
  );
});

test('lookups whose options vary per request beyond the where clause are left alone', (context) => {
  const [finding] = scan(
    context,
    guard('const user = await this.users.findOne({ where: { id: context.userId }, take: context.ids.length });'),
  );
  assert.equal(finding.fix, undefined);
});

test('guards that check revocation or roles get no cache, since a cached row would delay the change', (context) => {
  for (const check of ['user?.revokedAt', 'user?.role']) {
    const source = guard('const user = await this.users.findOne({ where: { id: context.userId } });').replace(
      'Boolean(user?.active)',
      `Boolean(${check})`,
    );
    const [finding] = scan(context, source);
    assert.ok(finding);
    assert.equal(finding.fix, undefined);
  }
});
