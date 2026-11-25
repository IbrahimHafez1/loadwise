// Breaking changes between two versions of an OpenAPI 3 or Swagger 2 JSON document.
import { ts } from '../compiler.js';
import type { Node } from 'typescript';
import type { ContractFinding, ContractSide } from '../types/contract-findings.js';
import type { SourcePosition } from '../types/source-position.js';

type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch';

/**
 * Any part of an OpenAPI 3 or Swagger 2 document that is read: a schema, parameter, response or
 * request body.
 */
interface OpenApiNode {
  $ref?: string;
  type?: string;
  items?: OpenApiNode;
  properties?: Record<string, OpenApiNode>;
  allOf?: OpenApiNode[];
  /** A list of property names on a schema, a flag on a parameter or request body. */
  required?: string[] | boolean;
  enum?: unknown[];
  in?: string;
  name?: string;
  schema?: OpenApiNode;
  content?: Record<string, OpenApiNode>;
  responses?: Record<string, OpenApiNode>;
  requestBody?: OpenApiNode;
  parameters?: OpenApiNode[];
}

type PathItem = { parameters?: OpenApiNode[] } & Partial<Record<HttpMethod, OpenApiNode>>;

interface OpenApiDocument {
  paths?: Record<string, PathItem>;
}

interface ResolvedNode {
  schema: OpenApiNode | undefined;
  segments: string[];
}

interface SchemaSource {
  document: OpenApiDocument;
  rawSchema: OpenApiNode | undefined;
  segments: string[];
}

/** One field of a flattened object schema, keyed by its dotted path. */
interface FlatField {
  type: string;
  required: boolean;
  enumValues: unknown[] | undefined;
  segments: string[];
}

interface ResponsePart {
  status: string;
  schema: OpenApiNode;
  segments: string[];
}

interface BodyPart {
  schema?: OpenApiNode;
  segments: string[];
  required: boolean;
  requiredSegments: string[];
  /** The body could not be resolved, so nothing is known about it. */
  unknown: boolean;
}

interface ParameterPart {
  label: string;
  required: boolean;
  type: string;
  enumValues: unknown[] | undefined;
  segments: string[];
}

interface OperationPart {
  document: OpenApiDocument;
  responses: ResponsePart[];
  body: BodyPart | undefined;
  parameters: Map<string, ParameterPart>;
}

type Locator = (segments: readonly string[]) => SourcePosition;

type OpenApiReport = (ruleId: string, side: ContractSide, segments: readonly string[], message: string) => void;

interface ComparisonContext {
  report: OpenApiReport;
  label: string;
}

const httpMethods: readonly HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const maxSchemaDepth = 8;

function lineStarts(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

// Binary search over the line starts, so locating every finding does not rescan the document.
function lineIndex(starts: readonly number[], position: number): SourcePosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: position - starts[low] + 1 };
}

// Maps a path of keys in the document to a line and column, falling back to the deepest key that
// exists.
function createLocator(text: string) {
  const sourceFile = ts.parseJsonText('document.json', text);
  const root = sourceFile.statements[0]?.expression;
  const starts = lineStarts(text);
  return function locate(segments: readonly string[]): SourcePosition {
    let node: Node | undefined = root;
    for (const segment of segments) {
      const child = childNode(node, segment);
      if (!child) break;
      node = child;
    }
    return lineIndex(starts, node ? node.getStart(sourceFile) : 0);
  };
}

function childNode(node: Node | undefined, segment: string): Node | undefined {
  if (node && ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if ((ts.isStringLiteral(name) || ts.isIdentifier(name)) && name.text === segment) return property.initializer;
    }
    return undefined;
  }
  if (node && ts.isArrayLiteralExpression(node)) return node.elements[Number(segment)];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOpenApiNode(value: unknown): value is OpenApiNode {
  return isRecord(value);
}

function resolveReference(document: OpenApiDocument, reference: string) {
  if (!reference.startsWith('#/')) return undefined;
  const segments = reference
    .slice(2)
    .split('/')
    .map((segment) => decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~'));
  let value: unknown = document;
  for (const segment of segments) value = isRecord(value) ? value[segment] : undefined;
  return isOpenApiNode(value) ? { value, segments } : undefined;
}

function resolveSchema(document: OpenApiDocument, schema: OpenApiNode | undefined, segments: string[]): ResolvedNode {
  if (typeof schema?.$ref !== 'string') return { schema, segments };
  const target = resolveReference(document, schema.$ref);
  return target ? { schema: target.value, segments: target.segments } : { schema: undefined, segments };
}

function schemaType(document: OpenApiDocument, rawSchema: OpenApiNode | undefined): string {
  const { schema } = resolveSchema(document, rawSchema, []);
  if (!schema) return 'any';
  if (schema.type === 'array') return `array<${schemaType(document, schema.items)}>`;
  if (typeof schema.type === 'string') return schema.type;
  return schema.properties ? 'object' : 'any';
}

interface SchemaPart {
  schema: OpenApiNode;
  segments: string[];
}

function compositeParts(
  document: OpenApiDocument,
  schema: OpenApiNode | undefined,
  segments: string[],
  seen: Set<OpenApiNode>,
) {
  const parts: SchemaPart[] = [];
  const collect = (rawSchema: OpenApiNode | undefined, rawSegments: string[]): void => {
    const resolved = resolveSchema(document, rawSchema, rawSegments);
    if (!resolved.schema || seen.has(resolved.schema)) return;
    seen.add(resolved.schema);
    parts.push({ schema: resolved.schema, segments: resolved.segments });
    (resolved.schema.allOf ?? []).forEach((member, index) =>
      collect(member, [...resolved.segments, 'allOf', String(index)]),
    );
  };
  collect(schema, segments);
  return parts;
}

// Flattens an object schema to `field.path` -> { type, required, enumValues, segments }. oneOf and
// anyOf are not walked.
function flattenSchema(
  { document, rawSchema, segments }: SchemaSource,
  fields = new Map<string, FlatField>(),
  prefix = '',
  depth = 0,
  seen = new Set<OpenApiNode>(),
): Map<string, FlatField> {
  if (depth > maxSchemaDepth) return fields;
  const { schema, segments: schemaSegments } = resolveSchema(document, rawSchema, segments);
  if (schema?.type === 'array') {
    return flattenSchema(
      { document, rawSchema: schema.items, segments: [...schemaSegments, 'items'] },
      fields,
      `${prefix}[]`,
      depth + 1,
      seen,
    );
  }
  const visited = new Set(seen);
  const parts = compositeParts(document, schema, schemaSegments, visited);
  const required = new Set(parts.flatMap((part) => (Array.isArray(part.schema.required) ? part.schema.required : [])));
  for (const part of parts) {
    for (const [name, property] of Object.entries(part.schema.properties ?? {})) {
      const propertySegments = [...part.segments, 'properties', name];
      const resolved = resolveSchema(document, property, propertySegments);
      const fieldPath = prefix ? `${prefix}.${name}` : name;
      fields.set(fieldPath, {
        type: schemaType(document, property),
        required: required.has(name),
        enumValues: resolved.schema?.enum,
        segments: propertySegments,
      });
      flattenSchema(
        { document, rawSchema: property, segments: propertySegments },
        fields,
        fieldPath,
        depth + 1,
        visited,
      );
    }
  }
  return fields;
}

function pickContent(content: Record<string, OpenApiNode> | undefined) {
  if (!content || typeof content !== 'object') return undefined;
  const mime = Object.keys(content).find((name) => name.includes('json')) ?? Object.keys(content)[0];
  return mime ? { schema: content[mime]?.schema, key: ['content', mime, 'schema'] } : undefined;
}

function successResponses(document: OpenApiDocument, operation: OpenApiNode, operationSegments: string[]) {
  const responses: ResponsePart[] = [];
  for (const [status, rawResponse] of Object.entries(operation.responses ?? {})) {
    if (!status.startsWith('2')) continue;
    const response = resolveSchema(document, rawResponse, [...operationSegments, 'responses', status]);
    const content = pickContent(response.schema?.content);
    const schema = content?.schema ?? response.schema?.schema;
    const key = content ? content.key : ['schema'];
    if (schema) responses.push({ status, schema, segments: [...response.segments, ...key] });
  }
  return responses;
}

function requestBodySchema(
  document: OpenApiDocument,
  pathItem: PathItem,
  operation: OpenApiNode,
  pathSegments: string[],
  operationSegments: string[],
): BodyPart | undefined {
  if (operation.requestBody) {
    const body = resolveSchema(document, operation.requestBody, [...operationSegments, 'requestBody']);
    if (!body.schema) return { unknown: true, segments: [], required: false, requiredSegments: [] };
    const content = pickContent(body.schema.content);
    return {
      schema: content?.schema,
      segments: [...body.segments, ...(content?.key ?? [])],
      required: body.schema.required === true,
      requiredSegments: [...body.segments, 'required'],
      unknown: false,
    };
  }
  // Swagger 2 operations can inherit the body parameter from their path item.
  const owners: [{ parameters?: OpenApiNode[] }, string[]][] = [
    [operation, operationSegments],
    [pathItem, pathSegments],
  ];
  for (const [owner, segments] of owners) {
    for (const [index, parameter] of (owner.parameters ?? []).entries()) {
      const body = resolveSchema(document, parameter, [...segments, 'parameters', String(index)]);
      if (!body.schema) return { unknown: true, segments: [], required: false, requiredSegments: [] };
      if (body.schema.in === 'body')
        return {
          schema: body.schema.schema,
          segments: [...body.segments, 'schema'],
          required: body.schema.required === true,
          requiredSegments: [...body.segments, 'required'],
          unknown: false,
        };
    }
  }
}

function parameterMap(
  document: OpenApiDocument,
  pathItem: PathItem,
  operation: OpenApiNode,
  pathSegments: string[],
  operationSegments: string[],
) {
  const parameters = new Map<string, ParameterPart>();
  const owners: [{ parameters?: OpenApiNode[] }, string[]][] = [
    [pathItem, pathSegments],
    [operation, operationSegments],
  ];
  for (const [owner, ownerSegments] of owners) {
    (owner.parameters ?? []).forEach((rawParameter, index) => {
      const segments = [...ownerSegments, 'parameters', String(index)];
      const resolved = resolveSchema(document, rawParameter, segments);
      const parameter = resolved.schema;
      if (!parameter || parameter.in === 'body') return;
      parameters.set(`${parameter.in}:${parameter.name}`, {
        label: `${parameter.in} parameter "${parameter.name}"`,
        required: parameter.required === true || parameter.in === 'path',
        type: schemaType(document, parameter.schema ?? parameter),
        enumValues: parameter.schema?.enum ?? parameter.enum,
        segments: resolved.segments,
      });
    });
  }
  return parameters;
}

function removedValues(oldValues: unknown, newValues: unknown) {
  if (!Array.isArray(oldValues) || !Array.isArray(newValues)) return [];
  return oldValues.filter((value) => !newValues.includes(value));
}

function comparable(left: string, right: string) {
  return left !== 'any' && right !== 'any' && left !== right;
}

// Every integer is a number, so `number` accepts all `integer` values (also as array items).
function acceptsAll(widerType: string, narrowerType: string): boolean {
  if (widerType === narrowerType || (widerType === 'number' && narrowerType === 'integer')) return true;
  const widerItems = /^array<(.*)>$/.exec(widerType);
  const narrowerItems = /^array<(.*)>$/.exec(narrowerType);
  return Boolean(widerItems && narrowerItems && acceptsAll(widerItems[1], narrowerItems[1]));
}

// Widening a request type and narrowing a response type keep old clients working.
function requestTypeBreaks(oldType: string, newType: string) {
  return comparable(oldType, newType) && !acceptsAll(newType, oldType);
}

function responseTypeBreaks(oldType: string, newType: string) {
  return comparable(oldType, newType) && !acceptsAll(oldType, newType);
}

function compareResponses({ report, label }: ComparisonContext, oldPart: OperationPart, newPart: OperationPart) {
  for (const oldResponse of oldPart.responses) {
    const newResponse = newPart.responses.find((response) => response.status === oldResponse.status);
    if (!newResponse) continue;
    const oldFields = flattenSchema({
      document: oldPart.document,
      rawSchema: oldResponse.schema,
      segments: oldResponse.segments,
    });
    const newFields = flattenSchema({
      document: newPart.document,
      rawSchema: newResponse.schema,
      segments: newResponse.segments,
    });
    for (const [fieldPath, oldField] of oldFields) {
      const newField = newFields.get(fieldPath);
      if (!newField) {
        report(
          'api-removed-field',
          'old',
          oldField.segments,
          `Response field "${fieldPath}" of ${label} (${oldResponse.status}) was removed. Clients that read it get undefined or fail to parse the response.`,
        );
      } else if (responseTypeBreaks(oldField.type, newField.type)) {
        report(
          'api-type-changed',
          'new',
          newField.segments,
          `Response field "${fieldPath}" of ${label} changed type from ${oldField.type} to ${newField.type}. Clients that parse it as ${oldField.type} break.`,
        );
      }
    }
  }
}

function compareRequestBody({ report, label }: ComparisonContext, oldPart: OperationPart, newPart: OperationPart) {
  if (newPart.body?.required && !oldPart.body?.required && !oldPart.body?.unknown) {
    report(
      'api-required-input',
      'new',
      newPart.body.requiredSegments,
      `The request body of ${label} is now required. Clients that omit it are rejected.`,
    );
  }
  if (!oldPart.body?.schema || !newPart.body?.schema) return;
  const oldFields = flattenSchema({
    document: oldPart.document,
    rawSchema: oldPart.body.schema,
    segments: oldPart.body.segments,
  });
  const newFields = flattenSchema({
    document: newPart.document,
    rawSchema: newPart.body.schema,
    segments: newPart.body.segments,
  });
  for (const [fieldPath, newField] of newFields) {
    const oldField = oldFields.get(fieldPath);
    const parentPath = fieldPath.replace(/\.?[^.]+$/, '');
    if (!oldField && parentPath && !oldFields.has(parentPath)) continue;
    if (newField.required && !oldField?.required) {
      report(
        'api-required-input',
        'new',
        newField.segments,
        `Request field "${fieldPath}" of ${label} is now required. Clients that do not send it get a 400 response.`,
      );
    } else if (oldField && requestTypeBreaks(oldField.type, newField.type)) {
      report(
        'api-type-changed',
        'new',
        newField.segments,
        `Request field "${fieldPath}" of ${label} changed type from ${oldField.type} to ${newField.type}. Clients that send ${oldField.type} are rejected.`,
      );
    }
    const removed = removedValues(oldField?.enumValues, newField.enumValues);
    if (removed.length) {
      report(
        'api-enum-value-removed',
        'new',
        newField.segments,
        `Request field "${fieldPath}" of ${label} no longer accepts ${removed.map((value) => JSON.stringify(value)).join(', ')}. Clients that send it are rejected.`,
      );
    }
  }
}

function compareParameters({ report, label }: ComparisonContext, oldPart: OperationPart, newPart: OperationPart) {
  for (const [key, newParameter] of newPart.parameters) {
    const oldParameter = oldPart.parameters.get(key);
    if (newParameter.required && !oldParameter?.required) {
      report(
        'api-required-input',
        'new',
        newParameter.segments,
        `The ${newParameter.label} of ${label} is now required. Clients that omit it get a 400 response.`,
      );
    } else if (oldParameter && requestTypeBreaks(oldParameter.type, newParameter.type)) {
      report(
        'api-type-changed',
        'new',
        newParameter.segments,
        `The ${newParameter.label} of ${label} changed type from ${oldParameter.type} to ${newParameter.type}. Clients that send ${oldParameter.type} are rejected.`,
      );
    }
    const removed = removedValues(oldParameter?.enumValues, newParameter.enumValues);
    if (removed.length) {
      report(
        'api-enum-value-removed',
        'new',
        newParameter.segments,
        `The ${newParameter.label} of ${label} no longer accepts ${removed.map((value) => JSON.stringify(value)).join(', ')}. Clients that send it are rejected.`,
      );
    }
  }
}

function compareOperation(context: ComparisonContext, oldPart: OperationPart, newPart: OperationPart) {
  compareResponses(context, oldPart, newPart);
  compareRequestBody(context, oldPart, newPart);
  compareParameters(context, oldPart, newPart);
}

function operationParts(
  document: OpenApiDocument,
  pathItem: PathItem,
  operation: OpenApiNode,
  pathSegments: string[],
  operationSegments: string[],
): OperationPart {
  return {
    document,
    responses: successResponses(document, operation, operationSegments),
    body: requestBodySchema(document, pathItem, operation, pathSegments, operationSegments),
    parameters: parameterMap(document, pathItem, operation, pathSegments, operationSegments),
  };
}

// Returns findings { ruleId, side: 'old' | 'new', line, column, message }; `side` says which text
// the line is in.
function compareOpenApi(oldText: string, newText: string): ContractFinding[] {
  const oldDocument: OpenApiDocument = JSON.parse(oldText);
  const newDocument: OpenApiDocument = JSON.parse(newText);
  const locators: Record<ContractSide, Locator> = { old: createLocator(oldText), new: createLocator(newText) };
  const findings: ContractFinding[] = [];
  for (const [pathName, oldItem] of Object.entries(oldDocument.paths ?? {})) {
    for (const method of httpMethods) {
      const oldOperation = oldItem?.[method];
      if (!oldOperation) continue;
      const label = `${method.toUpperCase()} ${pathName}`;
      const pathSegments = ['paths', pathName];
      const operationSegments = [...pathSegments, method];
      const report: OpenApiReport = (ruleId, side, segments, message) => {
        findings.push({ ruleId, side, ...locators[side](segments), message });
      };
      const newItem = newDocument.paths?.[pathName];
      const newOperation = newItem?.[method];
      if (!newItem || !newOperation) {
        report(
          'api-removed-operation',
          'old',
          operationSegments,
          `Operation ${label} was removed. Clients that call it get 404 or 405.`,
        );
        continue;
      }
      compareOperation(
        { report, label },
        operationParts(oldDocument, oldItem, oldOperation, pathSegments, operationSegments),
        operationParts(newDocument, newItem, newOperation, pathSegments, operationSegments),
      );
    }
  }
  return findings;
}

export { compareOpenApi };
