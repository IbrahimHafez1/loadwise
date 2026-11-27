// Finds the inline `template:` strings of Angular @Component decorators in a source file.
import type { Expression, Node, SourceFile } from 'typescript';
import { ts } from '../performance/compiler.js';
import { walkNodes } from '../reliability/walk.js';
import type { MarkupDocument } from './markup.js';
import { templateDocument } from './template-elements.js';

const componentDecoratorName = 'Component';

function componentOptions(node: Node): Node | undefined {
  if (!ts.isDecorator(node) || !ts.isCallExpression(node.expression)) return undefined;
  const call = node.expression;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== componentDecoratorName) return undefined;
  return call.arguments[0];
}

function templateLiteral(options: Node): Expression | undefined {
  if (!ts.isObjectLiteralExpression(options)) return undefined;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const isTemplate = ts.isIdentifier(property.name) && property.name.text === 'template';
    if (!isTemplate) continue;
    // A template with `${}` substitutions is not static markup.
    const { initializer } = property;
    return ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer) ? initializer : undefined;
  }
  return undefined;
}

/**
 * Parses each static inline template with the Angular dialect. The region is the literal's raw source between its
 * quotes, so positions point into the .ts file.
 */
function inlineAngularTemplates(sourceFile: SourceFile, file: string): MarkupDocument[] {
  const documents: MarkupDocument[] = [];
  walkNodes(sourceFile, (node) => {
    const options = componentOptions(node);
    const literal = options && templateLiteral(options);
    if (!literal) return;
    documents.push(
      templateDocument(file, sourceFile.text, 'angular', literal.getStart(sourceFile) + 1, literal.getEnd() - 1),
    );
  });
  return documents;
}

export { inlineAngularTemplates };
