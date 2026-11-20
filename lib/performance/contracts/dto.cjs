'use strict';

// Breaking changes in the classes a NestJS controller accepts with @Body() or returns. Syntax-level only: property
// names, optionality and written type text, compared between the base version and the working tree.
const { syntax: ts } = require('../compiler.cjs');

const responseDecorators = new Set([
  'ApiResponse',
  'ApiOkResponse',
  'ApiCreatedResponse',
  'ApiAcceptedResponse',
  'ApiDefaultResponse',
]);
const optionalDecorators = new Set(['IsOptional', 'ApiPropertyOptional']);
const wrapperTypes = new Set(['Promise', 'Observable', 'Array', 'ReadonlyArray']);

function parse(text) {
  return ts.createSourceFile('dto.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function decoratorsOf(node) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).map((decorator) => {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    return { name: (call?.expression ?? expression).getText(), arguments: call?.arguments ?? [] };
  });
}

// Class names a type node names, looking through Promise<>, Observable<>, arrays and unions with null.
function referencedClassNames(typeNode) {
  if (!typeNode) return [];
  if (ts.isArrayTypeNode(typeNode)) return referencedClassNames(typeNode.elementType);
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.flatMap(referencedClassNames);
  if (ts.isParenthesizedTypeNode(typeNode)) return referencedClassNames(typeNode.type);
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return [];
  const name = typeNode.typeName.text;
  if (wrapperTypes.has(name)) return (typeNode.typeArguments ?? []).flatMap(referencedClassNames);
  return [name];
}

function apiResponseTypeNames(decorator) {
  const options = decorator.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return [];
  const property = options.properties.find((member) => member.name?.getText() === 'type');
  const value = property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
  const element = value && ts.isArrayLiteralExpression(value) ? value.elements[0] : value;
  return element && ts.isIdentifier(element) ? [element.text] : [];
}

function importedSpecifiers(sourceFile) {
  const specifiers = new Map();
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) && statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      specifiers.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

// [{ name, role: 'input' | 'output', specifier: string | null }] for one controller's source text.
function controllerTypeUsages(text) {
  const sourceFile = parse(text);
  const specifiers = importedSpecifiers(sourceFile);
  const usages = [];
  const add = (names, role) => {
    for (const name of names) usages.push({ name, role, specifier: specifiers.get(name) ?? null });
  };
  const visit = (node) => {
    if (ts.isMethodDeclaration(node)) {
      add(referencedClassNames(node.type), 'output');
      decoratorsOf(node)
        .filter((decorator) => responseDecorators.has(decorator.name))
        .forEach((decorator) => add(apiResponseTypeNames(decorator), 'output'));
      for (const parameter of node.parameters) {
        if (decoratorsOf(parameter).some((decorator) => decorator.name === 'Body')) {
          add(referencedClassNames(parameter.type), 'input');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return usages;
}

function findDeclaration(sourceFile, className) {
  return sourceFile.statements.find(
    (statement) =>
      (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name?.text === className,
  );
}

function literalUnionValues(typeNode) {
  if (!typeNode) return null;
  const members = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
  const literals = members.map((member) => ts.isLiteralTypeNode(member) && member.literal.getText());
  return literals.every(Boolean) ? new Set(literals) : null;
}

function propertiesOf(sourceFile, declaration) {
  const properties = new Map();
  for (const member of declaration.members) {
    if (!(ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) || !member.name) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
    if (name === undefined) continue;
    const decorated = decoratorsOf(member).some((decorator) => optionalDecorators.has(decorator.name));
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(member.name.getStart());
    properties.set(name, {
      optional: Boolean(member.questionToken) || decorated,
      hasDefault: Boolean(member.initializer),
      typeText: member.type?.getText().replace(/\s+/g, ' '),
      literals: literalUnionValues(member.type),
      line: line + 1,
      column: character + 1,
    });
  }
  return properties;
}

// Returns findings { ruleId, side: 'old' | 'new', line, column, message } for one class used with the given roles.
function compareDto(oldText, newText, className, roles) {
  const oldFile = parse(oldText);
  const newFile = parse(newText);
  const oldDeclaration = findDeclaration(oldFile, className);
  const newDeclaration = findDeclaration(newFile, className);
  if (!oldDeclaration || !newDeclaration) return [];
  const oldProperties = propertiesOf(oldFile, oldDeclaration);
  const newProperties = propertiesOf(newFile, newDeclaration);
  const isInput = roles.has('input');
  const isOutput = roles.has('output');
  const findings = [];
  const report = (ruleId, side, location, message) =>
    findings.push({ ruleId, side, line: location.line, column: location.column, message });

  for (const [name, oldProperty] of oldProperties) {
    const newProperty = newProperties.get(name);
    const label = `${className}.${name}`;
    if (!newProperty) {
      if (isOutput) {
        report(
          'api-removed-field',
          'old',
          oldProperty,
          `Response property ${label} was removed. Clients that read it get undefined.`,
        );
      }
      continue;
    }
    if (isInput && oldProperty.optional && !newProperty.optional && !newProperty.hasDefault) {
      report(
        'api-required-input',
        'new',
        newProperty,
        `Request property ${label} is now required. Clients that omit it get a 400 response.`,
      );
    }
    if (oldProperty.literals && newProperty.literals) {
      const removed = [...oldProperty.literals].filter((literal) => !newProperty.literals.has(literal));
      if (isInput && removed.length) {
        report(
          'api-enum-value-removed',
          'new',
          newProperty,
          `Request property ${label} no longer accepts ${removed.join(', ')}. Clients that send it are rejected.`,
        );
      }
    } else if (oldProperty.typeText && newProperty.typeText && oldProperty.typeText !== newProperty.typeText) {
      const clients = isInput ? 'Clients that send the old type are rejected' : 'Clients that parse the old type break';
      report(
        'api-type-changed',
        'new',
        newProperty,
        `Property ${label} changed type from ${oldProperty.typeText} to ${newProperty.typeText}. ${clients}.`,
      );
    }
  }
  if (isInput) {
    for (const [name, newProperty] of newProperties) {
      if (oldProperties.has(name) || newProperty.optional || newProperty.hasDefault) continue;
      report(
        'api-required-input',
        'new',
        newProperty,
        `Request property ${className}.${name} is new and required. Clients that do not send it get a 400 response.`,
      );
    }
  }
  return findings;
}

module.exports = { compareDto, controllerTypeUsages };
