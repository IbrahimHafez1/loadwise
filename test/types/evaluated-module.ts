/**
 * A function a piece of evaluated source exports; the test calls it with whatever the source
 * expects.
 */
export type EvaluatedFunction = (...args: readonly unknown[]) => unknown;

/** The functions of evaluated CommonJS text, by export name. */
export type EvaluatedExports = Record<string, EvaluatedFunction>;

/**
 * Runs CommonJS text and returns its `module.exports`. The text decides what it exports, so
 * `Exports` is the shape the test expects of it; a wrong claim fails when the test calls the
 * missing member.
 */
export function evaluateCommonJs<Exports extends object = EvaluatedExports>(text: string): Exports {
  const module: { exports: object } = { exports: {} };
  new Function('module', 'exports', text)(module, module.exports);
  // The evaluated text is untyped; `Exports` is the caller's claim about its shape.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- evaluated text is untyped, Exports is the caller's claim
  return module.exports as Exports;
}
