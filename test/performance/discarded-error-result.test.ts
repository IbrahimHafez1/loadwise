import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';

const declarations = {
  'node_modules/fp-ts/Either.d.ts': `
export interface Left<E> { readonly _tag: 'Left'; readonly left: E; }
export interface Right<A> { readonly _tag: 'Right'; readonly right: A; }
export type Either<E, A> = Left<E> | Right<A>;
`,
  'node_modules/neverthrow/index.d.ts': `
export declare class Ok<T, E> { readonly value: T; isOk(): this is Ok<T, E>; }
export declare class Err<T, E> { readonly error: E; isErr(): this is Err<T, E>; }
export type Result<T, E> = Ok<T, E> | Err<T, E>;
export declare class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  then<A = Result<T, E>, B = never>(ok?: (value: Result<T, E>) => A | PromiseLike<A>, err?: (reason: unknown) => B | PromiseLike<B>): PromiseLike<A | B>;
}
`,
};
const header = `import type { Either } from 'fp-ts/Either';
import type { Ok, Result, ResultAsync } from 'neverthrow';
declare function updateProvider(): Promise<Either<string, true>>;
declare function parseRequest(): Result<string, Error>;
declare function saveResult(): ResultAsync<number, Error>;
declare function reportErrorOrSuccess(result: Either<string, true>): void;
`;

test('a bare, awaited or explicitly discarded error result is reported once', () => {
  const findings = lint(
    header +
      `
async function toggleSMTP() {
  updateProvider();
  await (updateProvider());
  void parseRequest();
  saveResult();
}
`,
    declarations,
  );
  assert.deepEqual(
    findings.map(({ ruleId }) => ruleId),
    Array(4).fill('discarded-error-result'),
  );
  assert.match(findings[0].message, /await.*inspect/i);
  assert.match(findings[1].message, /inspect/i);
});

test('observed results, unresolved types and unrelated look-alikes stay quiet', () => {
  const findings = lint(
    header +
      `
declare function unrelated(): { _tag: 'Left'; left: string } | { _tag: 'Right'; right: number };
declare function regularTask(): Promise<number>;
declare function successfulResult(): Ok<string, Error>;
async function handled() {
  reportErrorOrSuccess(await updateProvider());
  if (parseRequest().isOk()) return await updateProvider();
  await regularTask();
  successfulResult();
  unrelated();
  unresolved();
  return saveResult();
}
`,
    declarations,
  );
  assert.deepEqual(
    findings.filter(({ ruleId }) => ruleId === 'discarded-error-result'),
    [],
  );
});
