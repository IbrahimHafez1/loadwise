'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint, lintBothWays } = require('./helpers.cjs');

const jwtTypes = {
  'node_modules/@types/jsonwebtoken/index.d.ts': [
    'export declare function sign(payload: object | string, key: string | Buffer, options?: object): string;',
    'export declare function verify(token: string, key: string | Buffer | Function, options?: object): any;',
    'export declare function decode(token: string, options?: object): any;',
  ].join('\n'),
};
const nestJwtTypes = {
  'node_modules/@nestjs/jwt/index.d.ts': [
    'export declare class JwtModule { static register(options: object): object; }',
    'export declare class JwtService {',
    '  decode(token: string): any; verify(token: string): any;',
    '  sign(payload: object, options?: object): string; signAsync(payload: object, options?: object): Promise<string>;',
    '}',
  ].join('\n'),
  'node_modules/@nestjs/common/index.d.ts': 'export declare function Module(metadata: object): ClassDecorator;',
};

function summary(findings, ruleId) {
  return findings
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => [finding.line, Boolean(finding.contextualReason)]);
}

test('jwt-decode-for-auth reports a decoded payload that becomes the request user or runs in an auth function', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'export function authenticate(req, res, next) {',
    '  const claims = jwt.decode(req.headers.authorization);',
    '  req.user = claims;',
    '  next();',
    '}',
    'export function loadUser(token: string, db) {',
    '  const payload = jwt.decode(token) as any;',
    '  return db.user.findUnique({ where: { id: payload.sub } });',
    '}',
    'export class AuthGuard {',
    '  canActivate(context) {',
    '    const request = context.switchToHttp().getRequest();',
    '    return Boolean(jwt.decode(request.headers.authorization));',
    '  }',
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source, jwtTypes);
  assert.deepEqual(summary(typed, 'jwt-decode-for-auth'), [
    [3, false],
    [8, false],
    [14, false],
  ]);
  assert.deepEqual(summary(untyped, 'jwt-decode-for-auth'), summary(typed, 'jwt-decode-for-auth'));
});

test('jwt-decode-for-auth recognises NestJS JwtService and jwt-decode', () => {
  const findings = lint(
    [
      "import { JwtService } from '@nestjs/jwt';",
      "import { jwtDecode } from 'jwt-decode';",
      'export class Guard {',
      '  constructor(private readonly jwtService: JwtService) {}',
      '  canActivate(context) {',
      '    const user = this.jwtService.decode(context.token);',
      '    const other = jwtDecode(context.token);',
      '    return Boolean(user && other);',
      '  }',
      '}',
    ].join('\n'),
    nestJwtTypes,
  );
  assert.deepEqual(summary(findings, 'jwt-decode-for-auth'), [
    [6, false],
    [7, false],
  ]);
});

test('jwt-decode-for-auth is contextual outside auth code and silent for verified or housekeeping reads', () => {
  const findings = lint(
    [
      "import jwt from 'jsonwebtoken';",
      'export function describe(token: string) {',
      '  const claims = jwt.decode(token);',
      '  return JSON.stringify(claims);',
      '}',
      'export function verifiedFirst(token: string, key: string) {',
      '  jwt.verify(token, key, { algorithms: ["HS256"] });',
      '  return jwt.decode(token);',
      '}',
      'export function expiry(token: string) {',
      '  const decoded = jwt.decode(token) as any;',
      '  return decoded && decoded.exp;',
      '}',
      'export function expiredAlready(token: string) {',
      '  return (jwt.decode(token) as any)?.exp < Date.now() / 1000;',
      '}',
      'export function keyId(token: string) {',
      '  return jwt.decode(token, { complete: true })?.header.kid;',
      '}',
    ].join('\n'),
    jwtTypes,
  );
  assert.deepEqual(summary(findings, 'jwt-decode-for-auth'), [[3, true]]);
});

test('jwt-decode-for-auth ignores other libraries named decode and front-end files', () => {
  assert.deepEqual(
    lint(
      [
        "import { decode } from 'html-entities';",
        'export function authenticate(req, res, next) { req.user = decode(req.body.text); next(); }',
      ].join('\n'),
    ).filter((finding) => finding.ruleId === 'jwt-decode-for-auth'),
    [],
  );
});

test('jwt-verify-without-algorithms is default for asymmetric keys and key callbacks, contextual for shared secrets', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    "import fs from 'node:fs';",
    "const publicKey = fs.readFileSync('key.pem');",
    'export function check(token: string, secret: string, getKey: (header: any, done: any) => void) {',
    '  jwt.verify(token, publicKey);',
    '  jwt.verify(token, getKey, {}, () => {});',
    '  jwt.verify(token, process.env.JWT_PUBLIC_KEY!, { audience: "api" });',
    '  jwt.verify(token, secret);',
    '  jwt.verify(token, secret, (error, decoded) => decoded);',
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source, jwtTypes);
  assert.deepEqual(summary(typed, 'jwt-verify-without-algorithms'), [
    [5, false],
    [6, false],
    [7, false],
    [8, true],
    [9, true],
  ]);
  assert.deepEqual(summary(untyped, 'jwt-verify-without-algorithms'), summary(typed, 'jwt-verify-without-algorithms'));
});

test('jwt-verify-without-algorithms is silent when algorithms are pinned, options are not literal, or the call is another verify', () => {
  const findings = lint(
    [
      "import jwt from 'jsonwebtoken';",
      "import { createVerify } from 'node:crypto';",
      "const pinned = { algorithms: ['RS256' as const] };",
      'export function check(token: string, publicKey: string, options: object, verifier: { verify(a: string, b: string): boolean }) {',
      "  jwt.verify(token, publicKey, { algorithms: ['RS256'] });",
      '  jwt.verify(token, publicKey, pinned);',
      '  jwt.verify(token, publicKey, options);',
      '  jwt.verify(token, publicKey, { ...options });',
      '  verifier.verify(token, publicKey);',
      '}',
    ].join('\n'),
    jwtTypes,
  );
  assert.deepEqual(summary(findings, 'jwt-verify-without-algorithms'), []);
});

test('jwt-none-algorithm reports none in an algorithms list or a sign call, and nothing else', () => {
  const findings = lint(
    [
      "import jwt from 'jsonwebtoken';",
      "export const strategy = { algorithms: ['HS256', 'none'] };",
      "export const token = jwt.sign({ sub: '1' }, 'k', { algorithm: 'none', expiresIn: 60 });",
      "export const fine = { algorithms: ['RS256'], algorithm: 'RS256' };",
      "export const unrelated = { algorithm: 'none' };",
      'export const nonString = { algorithms: [none] };',
      'declare const none: string;',
    ].join('\n'),
    jwtTypes,
  );
  assert.deepEqual(summary(findings, 'jwt-none-algorithm'), [
    [2, false],
    [3, false],
  ]);
});

test('jwt-sign-without-expiry is default for literal payloads, contextual otherwise, silent with expiry', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'export function issue(user: { id: string }, claims: object, key: string) {',
    '  jwt.sign({ sub: user.id }, key);',
    '  jwt.sign({ sub: user.id }, key, { algorithm: "HS256" });',
    '  jwt.sign(claims, key);',
    '  jwt.sign({ sub: user.id }, key, { expiresIn: "15m" });',
    '  jwt.sign({ sub: user.id, exp: 1 }, key);',
    '  jwt.sign({ sub: user.id }, key, claims);',
    '  jwt.sign("raw", key);',
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source, jwtTypes);
  assert.deepEqual(summary(typed, 'jwt-sign-without-expiry'), [
    [3, false],
    [4, false],
    [5, true],
  ]);
  assert.deepEqual(summary(untyped, 'jwt-sign-without-expiry'), summary(typed, 'jwt-sign-without-expiry'));
});

test('jwt-sign-without-expiry applies only the Nest registration of the signing provider', () => {
  const source = [
    "import { JwtService } from '@nestjs/jwt';",
    'export class ScopedService {',
    '  constructor(private readonly jwt: JwtService) {}',
    '  issue() { return this.jwt.sign({ sub: "user" }); }',
    '}',
    'export class OtherService {',
    '  constructor(private readonly jwt: JwtService) {}',
    '  issue() { return this.jwt.signAsync({ sub: "user" }); }',
    '  short() { return this.jwt.sign({ sub: "user" }, { expiresIn: "30s" }); }',
    '  claim() { return this.jwt.sign({ sub: "user", exp: 42 }); }',
    '}',
  ].join('\n');
  const files = {
    ...nestJwtTypes,
    'scoped.module.ts': [
      "import { Module as NestModule } from '@nestjs/common';",
      "import { JwtModule as Tokens } from '@nestjs/jwt';",
      "import { ScopedService as Provider } from './main';",
      'const signOptions = { expiresIn: "15m" };',
      'const options = { signOptions };',
      '@NestModule({ imports: [Tokens.register(options)], providers: [Provider] })',
      'export class ScopedModule {}',
    ].join('\n'),
    'other.module.ts': [
      "import { Module } from '@nestjs/common';",
      "import * as jwt from '@nestjs/jwt';",
      "import { OtherService } from './main';",
      '@Module({ imports: [jwt.JwtModule.register({})], providers: [OtherService] })',
      'export class OtherModule {}',
    ].join('\n'),
  };
  const { typed, untyped } = lintBothWays(source, files);
  assert.deepEqual(summary(typed, 'jwt-sign-without-expiry'), [[8, false]]);
  assert.deepEqual(summary(untyped, 'jwt-sign-without-expiry'), [[8, false]]);
});

test('jwt-sign-without-expiry is contextual when the injected Nest configuration cannot be resolved', () => {
  const source = [
    "import { Module } from '@nestjs/common';",
    "import { JwtService } from '@nestjs/jwt';",
    'export class Service {',
    '  constructor(private readonly jwt: JwtService) {}',
    '  issue() { return this.jwt.sign({ sub: "user" }); }',
    '}',
    'const JwtModule = { register: (options: object) => options };',
    '@Module({ imports: [JwtModule.register({ signOptions: { expiresIn: 60 } })], providers: [Service] })',
    'export class AuthModule {}',
  ].join('\n');
  assert.deepEqual(summary(lint(source, nestJwtTypes), 'jwt-sign-without-expiry'), [[5, true]]);
});

test('jwt-sign-without-expiry does not rely on an imported default when a local provider overrides JwtService', () => {
  const source = [
    "import { Module } from '@nestjs/common';",
    "import { JwtModule, JwtService as TokenService } from '@nestjs/jwt';",
    'export class Service {',
    '  constructor(private readonly jwt: TokenService) {}',
    '  issue() { return this.jwt.sign({ sub: "user" }); }',
    '}',
    '@Module({',
    '  imports: [JwtModule.register({ signOptions: { expiresIn: 60 } })],',
    '  providers: [Service, { provide: TokenService, useValue: localService }],',
    '})',
    'export class AuthModule {}',
    'declare const localService: TokenService;',
  ].join('\n');
  assert.deepEqual(summary(lint(source, nestJwtTypes), 'jwt-sign-without-expiry'), [[5, true]]);
});
