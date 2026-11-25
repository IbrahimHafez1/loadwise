// upload-client-filename: multer disk storage that saves each upload under the file name the client
// sent.
import { ts } from '../../performance/compiler.js';
import { strip, nameText, calleeName, constantDeclaration } from './shared.js';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionExpression,
  MethodDeclaration,
  Node,
} from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'upload-client-filename';
const message =
  'Uploads are saved under the file name the client sent, so an upload with the same name replaces an earlier file and the client picks the extension it is served with. Generate the stored name (for example `randomUUID()` plus an allowlisted extension) and keep the original name as data.';

// String methods that keep the name recognisable: `file.originalname.replace(/\s/g, '_')` still
// collides.
const preservingMethods = new Set(['replace', 'replaceAll', 'toLowerCase', 'trim', 'normalize', 'toString']);
const maxDepth = 4;

function filenameCallback(
  options: Expression | undefined,
): MethodDeclaration | ArrowFunction | FunctionExpression | undefined {
  const literal = strip(options);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (nameText(property.name) !== 'filename') continue;
    if (ts.isMethodDeclaration(property)) return property;
    const value = ts.isPropertyAssignment(property) ? strip(property.initializer) : undefined;
    if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
  }
}

// True when `expression` is the client's name itself, possibly re-cased or with characters
// replaced.
function isClientName(
  expression: Expression | undefined,
  fileName: string,
  checker: CheckerAdapter,
  depth = 0,
): boolean {
  const node = strip(expression);
  if (!node || depth > maxDepth) return false;
  const next = (child: Expression | undefined) => isClientName(child, fileName, checker, depth + 1);
  if (ts.isPropertyAccessExpression(node)) {
    const object = strip(node.expression);
    return node.name.text === 'originalname' && ts.isIdentifier(object) && object.text === fileName;
  }
  if (ts.isIdentifier(node)) {
    const declaration = constantDeclaration(node, checker);
    return declaration !== undefined && next(declaration.initializer);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
    return preservingMethods.has(node.expression.name.text) && next(node.expression.expression);
  if (ts.isTemplateExpression(node))
    return (
      node.head.text === '' &&
      node.templateSpans.length === 1 &&
      node.templateSpans[0].literal.text === '' &&
      next(node.templateSpans[0].expression)
    );
  return false;
}

function checkDiskStorage(call: CallExpression, context: SecurityRuleContext) {
  const library = context.libraryCall(call);
  if (library?.module !== 'multer' || (library.method ?? library.exported) !== 'diskStorage') return;
  const callback = filenameCallback(call.arguments[0]);
  if (!callback) return;
  const [, file, done] = callback.parameters;
  if (!file || !done || !ts.isIdentifier(file.name) || !ts.isIdentifier(done.name) || !callback.body) return;
  const fileName = file.name.text;
  const doneName = done.name.text;
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && calleeName(node) === doneName && ts.isIdentifier(strip(node.expression))) {
      const stored = node.arguments[1];
      if (stored && isClientName(stored, fileName, context.checker)) context.report(node, ruleId, message);
    }
    ts.forEachChild(node, visit);
  })(callback.body);
}

export { ruleId, checkDiskStorage };
