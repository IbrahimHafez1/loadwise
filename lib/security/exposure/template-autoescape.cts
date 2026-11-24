// template-autoescape-disabled: a template engine configured to stop HTML-escaping every value it
// renders.
import { objectLiteralOf, findProperty, isTrue, isFalse } from './literals.cjs';
import type { CallExpression, Node } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.cjs';

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

function check(call: CallExpression, context: SecurityRuleContext) {
  const info = context.libraryCall(call);
  if (!info?.module || !Object.hasOwn(escapeSettings, info.module) || !call.arguments?.length) return;
  const functions = escapeSettings[info.module];
  const name = info.method ?? info.exported;
  if (!name || !Object.hasOwn(functions, name)) return;
  const [index, optionName, disables] = functions[name];
  // `nunjucks.configure(options)` or `nunjucks.configure(path, options)`: the options come last.
  const options = objectLiteralOf(call.arguments.at(index), context.checker);
  const option = options && findProperty(options, optionName);
  if (option && disables(option.value)) context.report(option.property, ruleId, message);
}

export { check };
