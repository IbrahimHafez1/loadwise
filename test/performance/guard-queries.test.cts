import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const RULE_ID = 'guard-query-per-request';
const files = {
  'node_modules/@nestjs/common/index.d.ts': `export interface CanActivate { canActivate(context: unknown): boolean | Promise<boolean>; }
    export interface NestInterceptor { intercept(context: unknown, next: unknown): unknown; }
    export interface NestMiddleware { use(req: unknown, res: unknown, next: () => void): void; }
    export declare function Injectable(): ClassDecorator;
    export declare function UseGuards(...guards: unknown[]): ClassDecorator & MethodDecorator;
    export declare function Controller(path?: string): ClassDecorator;
    export declare const APP_GUARD: string;`,
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      findOne(options?: object): Promise<T | null>;
      findOneBy(filter: object): Promise<T | null>;
    }`,
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate { findUnique(options: object): Promise<{ id: number } | null>; }
    export declare class PrismaClient { user: UserDelegate }`,
  'node_modules/pg/index.d.ts':
    'export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: object[] }>; }',
};
const header = `import { CanActivate, NestInterceptor, NestMiddleware, Injectable, UseGuards, Controller, APP_GUARD } from '@nestjs/common';
  import { Repository } from 'typeorm';
  import type { PrismaClient } from '@prisma/client';
  import { Pool } from 'pg';
  declare const cache: { get(key: string): Promise<object | null>; set(key: string, value: object): void; wrap<T>(key: string, load: () => Promise<T>): Promise<T> };
  declare const users: Repository<{ id: number }>, prisma: PrismaClient, pool: Pool, userId: number;
  `;
const globalRegistration = (name: string, token = 'APP_GUARD') => `
  export const providers = [{ provide: ${token}, useClass: ${name} }];`;

function guardFindings(body: string, registration = globalRegistration('SessionGuard')) {
  return lint(header + body + registration, files).filter((finding: Finding) => finding.ruleId === RULE_ID);
}

test('reports ORM, Prisma and pg lookups inside a globally registered guard', () => {
  const findings = guardFindings(`
    @Injectable()
    export class SessionGuard implements CanActivate {
      async canActivate(context: unknown) {
        const row = await users.findOne({ where: { id: userId } }); // typeorm
        const other = await prisma.user.findUnique({ where: { id: userId } }); // prisma
        const raw = await pool.query('select 1 from users where id = $1', [userId]); // pg
        return Boolean(row && other && raw);
      }
    }`);
  assert.equal(findings.length, 3);
  assert.match(findings[0].message, /SessionGuard.*registered globally/s);
});

test('covers interceptors, middleware, global use calls and helper methods one level deep', () => {
  const findings = guardFindings(
    `
    export class AuditInterceptor implements NestInterceptor {
      async intercept(context: unknown, next: unknown) { await users.findOneBy({ id: 1 }); return next; }
    }
    export class TenantMiddleware implements NestMiddleware {
      async use(req: unknown, res: unknown, next: () => void) { await this.load(); next(); }
      private load() { return users.findOneBy({ id: 2 }); }
    }
    export class SessionGuard implements CanActivate {
      canActivate() { return true; }
    }
    declare const app: { useGlobalInterceptors(...items: unknown[]): void };
    declare const consumer: { apply(...items: unknown[]): { forRoutes(path: string): void } };
    app.useGlobalInterceptors(new AuditInterceptor());
    consumer.apply(TenantMiddleware).forRoutes('*');`,
    '',
  );
  assert.deepEqual(findings.map((finding: Finding) => finding.line).length, 2);
});

test('controller-level guards are reported, method-level and unregistered guards are not', () => {
  const controllerLevel = guardFindings(
    `
    export class OwnerGuard implements CanActivate {
      async canActivate() { return Boolean(await users.findOneBy({ id: 1 })); }
    }
    @UseGuards(OwnerGuard)
    @Controller('x')
    export class XController {}`,
    '',
  );
  assert.equal(controllerLevel.length, 1);
  assert.match(controllerLevel[0].message, /controller/);

  const notRegistered = guardFindings(
    `
    export class OwnerGuard implements CanActivate {
      async canActivate() { return Boolean(await users.findOneBy({ id: 1 })); }
    }
    @Controller('x')
    export class XController { @UseGuards(OwnerGuard) one() {} }`,
    '',
  );
  assert.equal(notRegistered.length, 0);
});

test('cached lookups and non-guard classes are not reported', () => {
  const findings = guardFindings(`
    export class WrappedGuard implements CanActivate {
      async canActivate() { return Boolean(await cache.wrap('u', () => users.findOneBy({ id: 1 }))); }
    }
    export class ShortCircuitGuard implements CanActivate {
      async canActivate() {
        const cached = await cache.get('u');
        if (cached) return true;
        return Boolean(await users.findOneBy({ id: 1 }));
      }
    }
    export class MissBranchGuard implements CanActivate {
      async canActivate() {
        let user = await cache.get('u');
        if (!user) user = await users.findOneBy({ id: 1 });
        return Boolean(user);
      }
    }
    export class PlainService {
      async canActivate() { return Boolean(await users.findOneBy({ id: 1 })); }
    }
    export const providers2 = [
      { provide: APP_GUARD, useClass: WrappedGuard },
      { provide: APP_GUARD, useClass: ShortCircuitGuard },
      { provide: APP_GUARD, useClass: MissBranchGuard },
      { provide: APP_GUARD, useClass: PlainService },
    ];`);
  assert.deepEqual(findings, []);
});
