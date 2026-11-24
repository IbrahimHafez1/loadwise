import { typeFromPackage } from './package-types.cjs';
import { awaitedResult, isDiscardedValue } from './query-results.cjs';
import { isTestSource } from './review-context.cjs';
import type { CallExpression } from 'typescript';
import type { PerformanceRuleContext, ProgramAdapter, TypeAdapter } from '../shared/types.cjs';

interface ResultType {
  packages: readonly string[];
  failure: string;
  success: string;
  label: string;
}

const resultTypes: readonly ResultType[] = [
  { packages: ['fp-ts'], failure: 'Left', success: 'Right', label: 'Either' },
  { packages: ['neverthrow'], failure: 'Err', success: 'Ok', label: 'Result' },
];
const resultPackagePath = /[\\/]node_modules[\\/](?:fp-ts|neverthrow)[\\/]/;
const programHasResultTypes = new WeakMap<ProgramAdapter, boolean>();

function includesResultTypes(program: ProgramAdapter): boolean {
  const known = programHasResultTypes.get(program);
  if (known !== undefined) return known;
  const sources = program.getSourceFileNames?.() ?? program.getSourceFiles?.().map(({ fileName }) => fileName);
  const included = sources?.some((file) => resultPackagePath.test(file)) ?? true;
  programHasResultTypes.set(program, included);
  return included;
}

function canReturnError(type: TypeAdapter, { packages, failure, success }: ResultType): boolean {
  if (!typeFromPackage(type, packages, [failure, success])) return false;
  const branches = type.isUnion() ? (type.types ?? [type]) : [type];
  return branches.some((branch) => branch.getSymbol()?.name === failure);
}

function checkDiscardedErrorResult(call: CallExpression, context: PerformanceRuleContext): boolean {
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

export { checkDiscardedErrorResult };
