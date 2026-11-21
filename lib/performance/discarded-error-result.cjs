'use strict';

const { typeFromPackage } = require('./package-types.cjs');
const { awaitedResult, isDiscardedValue } = require('./query-results.cjs');
const { isTestSource } = require('./review-context.cjs');

const resultTypes = [
  { packages: ['fp-ts'], failure: 'Left', success: 'Right', label: 'Either' },
  { packages: ['neverthrow'], failure: 'Err', success: 'Ok', label: 'Result' },
];
const resultPackagePath = /[\\/]node_modules[\\/](?:fp-ts|neverthrow)[\\/]/;
const programHasResultTypes = new WeakMap();

function includesResultTypes(program) {
  if (!programHasResultTypes.has(program)) {
    const sources = program.getSourceFileNames?.() ?? program.getSourceFiles?.().map(({ fileName }) => fileName);
    programHasResultTypes.set(program, sources?.some((file) => resultPackagePath.test(file)) ?? true);
  }
  return programHasResultTypes.get(program);
}

function canReturnError(type, { packages, failure, success }) {
  if (!typeFromPackage(type, packages, [failure, success])) return false;
  const branches = type.isUnion() ? type.types : [type];
  return branches.some((branch) => branch.getSymbol()?.name === failure);
}

function checkDiscardedErrorResult(call, context) {
  if (!includesResultTypes(context.program)) return false;
  const awaited = awaitedResult(call);
  if (!isDiscardedValue(awaited ?? call) || isTestSource(call.getSourceFile().fileName)) return false;

  const { checker } = context;
  const directType = checker.getTypeAtLocation(awaited ?? call);
  const thenable = !awaited && Boolean(directType.getProperty('then'));
  const type = thenable
    ? (checker.getAwaitedTypeAtLocation?.(call) ?? checker.getAwaitedType?.(directType))
    : directType;
  const result = type && resultTypes.find((resultType) => canReturnError(type, resultType));
  if (!result) return false;

  context.report(
    call,
    'discarded-error-result',
    `This call's \`${result.label}\` result is discarded, so any failure returned as a value goes unnoticed. ` +
      (thenable
        ? 'Await it and inspect the error branch, or return the promise to its caller.'
        : 'Inspect the error branch or return the result to its caller.'),
  );
  return true;
}

module.exports = { checkDiscardedErrorResult };
