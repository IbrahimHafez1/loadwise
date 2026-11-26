// xml-external-entities: libxmljs asked to load external entities or the DTD.
import { ts } from '../../performance/compiler.js';
import { objectLiteralOf, findProperty, isTrue, unwrap } from './literals.js';
import type { CallExpression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'xml-external-entities';
const message =
  'This XML parser resolves external entities, which lets a document read local files or call internal URLs. Remove `noent`/`dtdload`.';
const parseFunctions = new Set(['parseXml', 'parseXmlString']);
const entityOptions = ['noent', 'dtdload'];
const libxmlModules = new Set(['libxmljs', 'libxmljs2']);

function check(call: CallExpression, context: SecurityRuleContext) {
  if (call.arguments.length < 2) return;
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !parseFunctions.has(callee.name.text)) return;
  const info = context.libraryCall(call);
  const functionName = info?.method ?? info?.exported;
  if (!info?.module || !libxmlModules.has(info.module) || !functionName || !parseFunctions.has(functionName)) return;
  const options = objectLiteralOf(call.arguments[1], context.checker);
  if (!options) return;
  for (const name of entityOptions) {
    const option = findProperty(options, name);
    if (option && isTrue(option.value)) context.report(option.property, ruleId, message);
  }
}

export { check };
