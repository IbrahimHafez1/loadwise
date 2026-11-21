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
const maxInheritanceDepth = 5;
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
      name,
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

// Own properties plus those inherited through `extends` of a class in a relative import. An inherited property is
// reported at the extending class, since its own line is in another file.
function allProperties({ side, file, sourceFile, declaration, readModule }, depth = 0) {
  const properties = propertiesOf(sourceFile, declaration);
  const baseReference = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types[0]?.expression;
  if (!baseReference || !ts.isIdentifier(baseReference) || depth >= maxInheritanceDepth) return properties;
  const specifier = importedSpecifiers(sourceFile).get(baseReference.text);
  const module = specifier ? readModule(side, file, specifier) : { file, text: sourceFile.text };
  if (!module) return properties;
  const baseFile = module.file === file ? sourceFile : parse(module.text);
  const baseDeclaration = findDeclaration(baseFile, baseReference.text);
  if (!baseDeclaration || baseDeclaration === declaration) return properties;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart());
  const inherited = allProperties(
    { side, file: module.file, sourceFile: baseFile, declaration: baseDeclaration, readModule },
    depth + 1,
  );
  for (const property of inherited.values()) {
    if (!properties.has(property.name))
      properties.set(property.name, { ...property, line: line + 1, column: character + 1 });
  }
  return properties;
}

// Returns findings { ruleId, side: 'old' | 'new', line, column, message } for one class used with the given roles.
// `options.forbidsUnknownInput`: the app rejects unknown request properties. `options.readModule(side, file, specifier)`
// returns { file, text } of a relative import, or null.
function compareDto(oldText, newText, className, roles, { file, forbidsUnknownInput, readModule }) {
  const oldFile = parse(oldText);
  const newFile = parse(newText);
  const oldDeclaration = findDeclaration(oldFile, className);
  const newDeclaration = findDeclaration(newFile, className);
  if (!oldDeclaration || !newDeclaration) return [];
  const oldProperties = allProperties({
    side: 'old',
    file,
    sourceFile: oldFile,
    declaration: oldDeclaration,
    readModule,
  });
  const newProperties = allProperties({
    side: 'new',
    file,
    sourceFile: newFile,
    declaration: newDeclaration,
    readModule,
  });
  const isInput = roles.has('input');
  const isOutput = roles.has('output');
  const findings = [];
  const report = (ruleId, side, location, message) =>
    findings.push({ ruleId, side, line: location.line, column: location.column, message });

  for (const [name, oldProperty] of oldProperties) {
    const newProperty = newProperties.get(name);
    const label = `${className}.${name}`;
    if (!newProperty) {
      const rejected = isInput && forbidsUnknownInput;
      if (isOutput || rejected) {
        const responseText = `Response property ${label} was removed. Clients that read it get undefined.`;
        const requestText = `Request property ${label} was removed and the app rejects unknown properties (ValidationPipe forbidNonWhitelisted). Clients that still send it now get a 400 response.`;
        report(
          'api-removed-field',
          'old',
          oldProperty,
          isOutput && rejected ? `${responseText} ${requestText}` : isOutput ? responseText : requestText,
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
