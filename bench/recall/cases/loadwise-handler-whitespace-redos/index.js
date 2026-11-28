// Pre-fix Loadwise propagation-only handler test (lib/accessibility/template-attributes.ts, PR #7): the call's trailing `\s*` and the final `\s*` split the spaces in `e.stopPropagation()<spaces>|| doSomething()`.
module.exports = function isPropagationOnly(value) {
  return /^\s*(?:(?:\([\w$]*\)|[\w$]+)\s*=>\s*)?(?:\{\s*)?(?:[\w$]+\.(?:stopPropagation|preventDefault)\(\)(?:\s*;)?\s*)+\}?\s*$/.test(
    value,
  );
};
