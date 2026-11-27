// template-autoescape-disabled: a template engine configured to stop HTML-escaping every value it
// renders.
import { ts } from '../../performance/compiler.js';
import { classifyExecutionContext } from '../../shared/execution-context.js';
import { objectLiteralOf, findProperty, isTrue, isFalse, unwrap } from './literals.js';
import type { CallExpression, Node } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'template-autoescape-disabled';
const message =
  'HTML escaping is turned off for every template this engine renders, so a user-controlled value shown in any view can run as script. Keep escaping on and mark trusted HTML one value at a time.';
// Module -> function -> [index of the options argument, option name, value that disables escaping].
type EscapeSetting = readonly [
  argumentIndex: number,
  optionName: string,
  disables: (node: Node | undefined) => boolean,
];
const escapeSettings: Record<string, Record<string, EscapeSetting>> = {
  swig: { setDefaults: [0, 'autoescape', isFalse] },
  nunjucks: { configure: [-1, 'autoescape', isFalse], Environment: [1, 'autoescape', isFalse] },
  handlebars: { compile: [1, 'noEscape', isTrue], precompile: [1, 'noEscape', isTrue] },
};
const escapeMethods = new Set(['setDefaults', 'configure', 'Environment', 'compile', 'precompile']);

function check(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments?.length) return;
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !escapeMethods.has(callee.name.text)) return;
  const info = context.libraryCall(call);
  if (!info?.module || !Object.hasOwn(escapeSettings, info.module)) return;
  const functions = escapeSettings[info.module];
  const name = info.method ?? info.exported;
  if (!name || !Object.hasOwn(functions, name)) return;
  const [index, optionName, disables] = functions[name];
  // `nunjucks.configure(options)` or `nunjucks.configure(path, options)`: the options come last.
  const options = objectLiteralOf(call.arguments.at(index), context.checker);
  const option = options && findProperty(options, optionName);
  if (option && disables(option.value)) {
    const runtime = classifyExecutionContext(context.sourceFile).runtime;
    const reason =
      runtime === 'cli-tooling' || runtime === 'test-fixture'
        ? 'Runs in CLI or test tooling rather than a server request path.'
        : undefined;
    context.report(option.property, ruleId, message, reason);
  }
}

export { check };
