// Breaking changes between two versions of a GraphQL schema written in SDL. Reads only the
// type-system subset.
import type { ContractFinding, ContractSide } from '../types/contract-findings.js';

interface Token {
  value: string;
  line: number;
  column: number;
}

type TypeReference =
  { kind: 'list'; of: TypeReference } | { kind: 'nonNull'; of: TypeReference } | { kind: 'named'; name: string };

interface Location {
  line: number;
  column: number;
}

interface InputValue extends Location {
  name: string;
  type: TypeReference;
  hasDefault: boolean;
}

interface FieldDefinition extends InputValue {
  args: Map<string, InputValue>;
}

interface EnumValueDefinition extends Location {
  name: string;
}

interface TypeDefinition extends Location {
  kind: string;
  name: string;
  fields: Map<string, FieldDefinition>;
  values: Map<string, EnumValueDefinition>;
}

interface SdlDocument {
  types: Map<string, TypeDefinition>;
  rootNames: Record<string, string>;
}

type Report = (ruleId: string, side: ContractSide, location: Location, message: string) => void;

/**
 * Client operation documents share the .graphql extension; they are not an API contract, so they
 * are skipped quietly.
 */
class OperationDocumentError extends Error {
  readonly isOperationDocument = true;
}

const tokenPattern =
  /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*|\.\.\.|[!$&():=@[\]{|}]|[_A-Za-z][_0-9A-Za-z]*|-?\d[\d.eE+-]*|[,\s﻿]+|[\s\S]/y;
const definitionKeywords = new Set(['type', 'interface', 'input', 'enum', 'union', 'scalar', 'schema', 'directive']);
const rootOperationNames = ['Query', 'Mutation', 'Subscription'];

function tokenize(text: string) {
  const tokens: Token[] = [];
  let line = 1;
  let lineStart = 0;
  tokenPattern.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = tokenPattern.exec(text));) {
    const value = match[0];
    const isIgnored = /^(?:[,\s﻿]+|#.*)$/.test(value);
    if (!isIgnored) tokens.push({ value, line, column: match.index - lineStart + 1 });
    for (let offset = value.indexOf('\n'); offset >= 0; offset = value.indexOf('\n', offset + 1)) {
      line++;
      lineStart = match.index + offset + 1;
    }
  }
  return tokens;
}

const isString = (token: Token | undefined) => token?.value.startsWith('"');
const isName = (token: Token | undefined) => /^[_A-Za-z]/.test(token?.value ?? '');

function createParser(tokens: Token[]) {
  let index = 0;
  const peek = (): Token | undefined => tokens[index];
  const next = (): Token => tokens[index++];
  const fail: (message: string) => never = (message) => {
    const token = peek();
    throw new Error(`${message} at line ${token?.line ?? 'end of file'}`);
  };
  const accept = (value: string) => {
    if (peek()?.value !== value) return false;
    index++;
    return true;
  };
  const expect = (value: string) => {
    if (!accept(value)) fail(`Expected "${value}"`);
  };
  const skipDescription = () => {
    while (isString(peek())) index++;
  };
  const name = (): Token => {
    if (!isName(peek())) fail('Expected a name');
    return next();
  };
  // Skips a balanced value such as a default or a directive argument.
  const skipValue = () => {
    const token = next();
    if (!token) fail('Unexpected end of file');
    const closers: Record<string, string> = { '[': ']', '{': '}', '(': ')' };
    if (!closers[token.value]) return;
    for (let depth = 1; depth > 0;) {
      const inner = next();
      if (!inner) fail('Unbalanced brackets');
      if (closers[inner.value]) depth++;
      else if (Object.values(closers).includes(inner.value)) depth--;
    }
  };
  const skipDirectives = () => {
    while (accept('@')) {
      name();
      if (peek()?.value === '(') skipValue();
    }
  };
  const typeReference = (): TypeReference => {
    let type: TypeReference;
    if (accept('[')) {
      type = { kind: 'list', of: typeReference() };
      expect(']');
    } else {
      type = { kind: 'named', name: name().value };
    }
    return accept('!') ? { kind: 'nonNull', of: type } : type;
  };
  const inputValue = (): InputValue => {
    skipDescription();
    const token = name();
    expect(':');
    const type = typeReference();
    const hasDefault = accept('=');
    if (hasDefault) skipValue();
    skipDirectives();
    return { name: token.value, type, hasDefault, line: token.line, column: token.column };
  };
  const argumentList = () => {
    const args = new Map<string, InputValue>();
    if (!accept('(')) return args;
    while (!accept(')')) {
      const argument = inputValue();
      args.set(argument.name, argument);
    }
    return args;
  };
  const fieldList = (isInput: boolean) => {
    const fields = new Map<string, FieldDefinition>();
    if (!accept('{')) return fields;
    while (!accept('}')) {
      skipDescription();
      const token = name();
      const args = isInput ? new Map() : argumentList();
      expect(':');
      const type = typeReference();
      const hasDefault = accept('=');
      if (hasDefault) skipValue();
      skipDirectives();
      fields.set(token.value, { name: token.value, args, type, hasDefault, line: token.line, column: token.column });
    }
    return fields;
  };
  const enumValues = () => {
    const values = new Map<string, EnumValueDefinition>();
    if (!accept('{')) return values;
    while (!accept('}')) {
      skipDescription();
      const token = name();
      skipDirectives();
      values.set(token.value, { name: token.value, line: token.line, column: token.column });
    }
    return values;
  };
  return {
    peek,
    next,
    fail,
    accept,
    expect,
    skipDescription,
    name,
    skipValue,
    skipDirectives,
    fieldList,
    enumValues,
    argumentList,
  };
}

type SdlParser = ReturnType<typeof createParser>;

function definitionFor(types: Map<string, TypeDefinition>, kind: string, token: Token) {
  const existing = types.get(token.value);
  if (existing) return existing;
  const created: TypeDefinition = {
    kind,
    name: token.value,
    line: token.line,
    column: token.column,
    fields: new Map(),
    values: new Map(),
  };
  types.set(token.value, created);
  return created;
}

function parseDefinition(parser: SdlParser, document: SdlDocument) {
  parser.skipDescription();
  if (!parser.peek()) return;
  parser.accept('extend');
  const keyword = parser.next();
  if (!definitionKeywords.has(keyword.value)) {
    throw new OperationDocumentError(`"${keyword.value}" at line ${keyword.line} is not a type-system definition`);
  }
  if (keyword.value === 'schema') {
    parser.skipDirectives();
    parser.expect('{');
    while (!parser.accept('}')) {
      const operation = parser.name().value;
      parser.expect(':');
      document.rootNames[operation] = parser.name().value;
    }
    return;
  }
  if (keyword.value === 'directive') {
    parser.expect('@');
    parser.name();
    parser.argumentList();
    parser.accept('repeatable');
    parser.expect('on');
    parser.accept('|');
    parser.name();
    while (parser.accept('|')) parser.name();
    return;
  }
  const type = definitionFor(document.types, keyword.value, parser.name());
  skipImplementedInterfaces(parser);
  parser.skipDirectives();
  if (keyword.value === 'enum') {
    for (const [valueName, value] of parser.enumValues()) type.values.set(valueName, value);
  } else if (keyword.value === 'union') {
    if (parser.accept('=')) {
      parser.accept('|');
      do {
        const member = parser.name();
        type.values.set(member.value, { name: member.value, line: member.line, column: member.column });
      } while (parser.accept('|'));
    }
  } else if (keyword.value !== 'scalar') {
    for (const [fieldName, field] of parser.fieldList(keyword.value === 'input')) type.fields.set(fieldName, field);
  }
}

function skipImplementedInterfaces(parser: SdlParser) {
  if (parser.accept('implements')) {
    parser.accept('&');
    parser.name();
    while (parser.accept('&')) parser.name();
  }
}

// Returns { types: Map, rootNames: { query, mutation, subscription } }. Throws on anything that is
// not SDL.
function parseSdl(text: string): SdlDocument {
  const parser = createParser(tokenize(text));
  const document: SdlDocument = { types: new Map(), rootNames: {} };
  while (parser.peek()) parseDefinition(parser, document);
  return document;
}

function typeText(type: TypeReference): string {
  if (type.kind === 'list') return `[${typeText(type.of)}]`;
  if (type.kind === 'nonNull') return `${typeText(type.of)}!`;
  return type.name;
}

// Whether every value of `candidate` is also a value of `target`.
function isSubtype(candidate: TypeReference, target: TypeReference): boolean {
  if (target.kind === 'nonNull') return candidate.kind === 'nonNull' && isSubtype(candidate.of, target.of);
  if (candidate.kind === 'nonNull') return isSubtype(candidate.of, target);
  if (target.kind === 'list') return candidate.kind === 'list' && isSubtype(candidate.of, target.of);
  return candidate.kind === 'named' && candidate.name === target.name;
}

function unwrapNonNull(type: TypeReference) {
  return type.kind === 'nonNull' ? type.of : type;
}

function rootTypeNames(document: SdlDocument) {
  const names = new Set(rootOperationNames);
  for (const name of Object.values(document.rootNames)) names.add(name);
  return names;
}

function compareInputValue(report: Report, label: string, oldValue: InputValue | undefined, newValue: InputValue) {
  const widened = unwrapNonNull(newValue.type);
  if (!oldValue) {
    if (newValue.type.kind === 'nonNull' && !newValue.hasDefault) {
      report(
        'api-required-input',
        'new',
        newValue,
        `${label} is new and non-null without a default. Clients that omit it get a validation error.`,
      );
    }
    return;
  }
  if (isSubtype(oldValue.type, newValue.type)) {
    if (newValue.type.kind === 'nonNull' && oldValue.hasDefault && !newValue.hasDefault) {
      report(
        'api-required-input',
        'new',
        newValue,
        `${label} lost its default. Clients that omit it now get a validation error.`,
      );
    }
    return;
  }
  const becameRequired = newValue.type.kind === 'nonNull' && isSubtype(oldValue.type, widened) && !newValue.hasDefault;
  report(
    becameRequired ? 'api-required-input' : 'api-type-changed',
    'new',
    newValue,
    `${label} changed from ${typeText(oldValue.type)} to ${typeText(newValue.type)}. Clients that send the old type ${becameRequired ? 'or omit it ' : ''}get a validation error.`,
  );
}

function compareArguments(report: Report, label: string, oldField: FieldDefinition, newField: FieldDefinition) {
  for (const [argumentName, oldArgument] of oldField.args) {
    if (!newField.args.has(argumentName)) {
      report(
        'api-removed-field',
        'old',
        oldArgument,
        `Argument ${label}(${argumentName}) was removed. Clients that pass it get a validation error.`,
      );
    }
  }
  for (const [argumentName, newArgument] of newField.args) {
    compareInputValue(report, `Argument ${label}(${argumentName})`, oldField.args.get(argumentName), newArgument);
  }
}

function compareTypeFields(report: Report, oldType: TypeDefinition, newType: TypeDefinition, isOperation: boolean) {
  const typeName = oldType.name;
  const isInput = oldType.kind === 'input';
  for (const [fieldName, oldField] of oldType.fields) {
    const label = `${typeName}.${fieldName}`;
    const newField = newType.fields.get(fieldName);
    if (!newField) {
      const ruleId = isOperation ? 'api-removed-operation' : 'api-removed-field';
      const clients = isInput
        ? 'Clients that send it'
        : isOperation
          ? 'Clients that call it'
          : 'Clients that select it';
      report(
        ruleId,
        'old',
        oldField,
        `${isOperation ? 'Operation' : 'Field'} ${label} was removed. ${clients} get a validation error.`,
      );
      continue;
    }
    if (isInput) {
      compareInputValue(report, `Input field ${label}`, oldField, newField);
    } else if (!isSubtype(newField.type, oldField.type)) {
      report(
        'api-type-changed',
        'new',
        newField,
        `Field ${label} changed from ${typeText(oldField.type)} to ${typeText(newField.type)}. Clients that rely on the old type break.`,
      );
    }
    compareArguments(report, label, oldField, newField);
  }
  if (isInput) {
    for (const [fieldName, newField] of newType.fields) {
      if (!oldType.fields.has(fieldName)) {
        compareInputValue(report, `Input field ${typeName}.${fieldName}`, undefined, newField);
      }
    }
  }
}

function compareGraphql(oldText: string, newText: string): ContractFinding[] {
  const oldDocument = parseSdl(oldText);
  const newDocument = parseSdl(newText);
  const roots = rootTypeNames(oldDocument);
  const findings: ContractFinding[] = [];
  const report: Report = (ruleId, side, location, message) => {
    findings.push({ ruleId, side, line: location.line, column: location.column, message });
  };

  for (const [typeName, oldType] of oldDocument.types) {
    const newType = newDocument.types.get(typeName);
    if (!newType) {
      report(
        'api-removed-field',
        'old',
        oldType,
        `${oldType.kind} ${typeName} was removed. Clients that query, send or select it get a validation error.`,
      );
      continue;
    }
    compareTypeFields(report, oldType, newType, roots.has(typeName));
    for (const [valueName, oldValue] of oldType.values) {
      if (newType.values.has(valueName)) continue;
      const isUnion = oldType.kind === 'union';
      report(
        isUnion ? 'api-removed-field' : 'api-enum-value-removed',
        'old',
        oldValue,
        isUnion
          ? `${valueName} is no longer a member of union ${typeName}. Clients that spread on ${valueName} never match it.`
          : `Enum value ${typeName}.${valueName} was removed. Clients that send it, or that handle it in a response, break.`,
      );
    }
  }
  return findings;
}

export { compareGraphql, parseSdl, OperationDocumentError };
