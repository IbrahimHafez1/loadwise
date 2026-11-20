'use strict';

// Breaking changes between two versions of an OpenAPI 3 or Swagger 2 JSON document.
const { syntax: ts } = require('../compiler.cjs');

const httpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const maxSchemaDepth = 8;

function lineIndex(text, position) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

// Maps a path of keys in the document to a line and column, falling back to the deepest key that exists.
function createLocator(text) {
  const sourceFile = ts.parseJsonText('document.json', text);
  const root = sourceFile.statements[0]?.expression;
  return function locate(segments) {
    let node = root;
    for (const segment of segments) {
      const child = childNode(node, segment);
      if (!child) break;
      node = child;
    }
    return lineIndex(text, node ? node.getStart(sourceFile) : 0);
  };
}

function childNode(node, segment) {
  if (node?.kind === ts.SyntaxKind.ObjectLiteralExpression) {
    return node.properties.find((property) => property.name && String(property.name.text) === String(segment))
      ?.initializer;
  }
  if (node?.kind === ts.SyntaxKind.ArrayLiteralExpression) return node.elements[Number(segment)];
  return undefined;
}

function resolveReference(document, reference) {
  if (!reference.startsWith('#/')) return undefined;
  const segments = reference
    .slice(2)
    .split('/')
    .map((segment) => decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~'));
  let value = document;
  for (const segment of segments) value = value?.[segment];
  return value && typeof value === 'object' ? { value, segments } : undefined;
}

function resolveSchema(document, schema, segments) {
  if (typeof schema?.$ref !== 'string') return { schema, segments };
  const target = resolveReference(document, schema.$ref);
  return target ? { schema: target.value, segments: target.segments } : { schema: undefined, segments };
}

function schemaType(document, rawSchema) {
  const { schema } = resolveSchema(document, rawSchema, []);
  if (!schema) return 'any';
  if (schema.type === 'array') return `array<${schemaType(document, schema.items)}>`;
  if (typeof schema.type === 'string') return schema.type;
  return schema.properties ? 'object' : 'any';
}

function compositeParts(document, schema, segments, seen) {
  const parts = [];
  const collect = (rawSchema, rawSegments) => {
    const resolved = resolveSchema(document, rawSchema, rawSegments);
    if (!resolved.schema || seen.has(resolved.schema)) return;
    seen.add(resolved.schema);
    parts.push(resolved);
    (resolved.schema.allOf ?? []).forEach((member, index) =>
      collect(member, [...resolved.segments, 'allOf', String(index)]),
    );
  };
  collect(schema, segments);
  return parts;
}

// Flattens an object schema to `field.path` -> { type, required, enumValues, segments }. oneOf and anyOf are not walked.
function flattenSchema(document, rawSchema, segments, fields = new Map(), prefix = '', depth = 0, seen = new Set()) {
  if (depth > maxSchemaDepth) return fields;
  const { schema, segments: schemaSegments } = resolveSchema(document, rawSchema, segments);
  if (schema?.type === 'array') {
    return flattenSchema(document, schema.items, [...schemaSegments, 'items'], fields, `${prefix}[]`, depth + 1, seen);
  }
  const visited = new Set(seen);
  const parts = compositeParts(document, schema, schemaSegments, visited);
  const required = new Set(parts.flatMap((part) => part.schema.required ?? []));
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
      flattenSchema(document, property, propertySegments, fields, fieldPath, depth + 1, visited);
    }
  }
  return fields;
}

function pickContent(content) {
  if (!content || typeof content !== 'object') return undefined;
  const mime = Object.keys(content).find((name) => name.includes('json')) ?? Object.keys(content)[0];
  return mime ? { schema: content[mime]?.schema, key: ['content', mime, 'schema'] } : undefined;
}

function successResponses(document, operation, operationSegments) {
  const responses = [];
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

function requestBodySchema(document, operation, operationSegments) {
  const body = resolveSchema(document, operation.requestBody, [...operationSegments, 'requestBody']);
  const content = pickContent(body.schema?.content);
  if (content) return { schema: content.schema, segments: [...body.segments, ...content.key] };
  const index = (operation.parameters ?? []).findIndex((parameter) => parameter.in === 'body');
  if (index < 0) return undefined;
  const parameter = operation.parameters[index];
  return { schema: parameter.schema, segments: [...operationSegments, 'parameters', String(index), 'schema'] };
}

function parameterMap(document, pathItem, operation, pathSegments, operationSegments) {
  const parameters = new Map();
  for (const [owner, ownerSegments] of [
    [pathItem, pathSegments],
    [operation, operationSegments],
  ]) {
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

function removedValues(oldValues, newValues) {
  if (!Array.isArray(oldValues) || !Array.isArray(newValues)) return [];
  return oldValues.filter((value) => !newValues.includes(value));
}

function compareOperation(context, oldPart, newPart) {
  const { report, label } = context;
  const comparable = (left, right) => left !== 'any' && right !== 'any' && left !== right;

  for (const oldResponse of oldPart.responses) {
    const newResponse = newPart.responses.find((response) => response.status === oldResponse.status);
    if (!newResponse) continue;
    const oldFields = flattenSchema(oldPart.document, oldResponse.schema, oldResponse.segments);
    const newFields = flattenSchema(newPart.document, newResponse.schema, newResponse.segments);
    for (const [fieldPath, oldField] of oldFields) {
      const newField = newFields.get(fieldPath);
      if (!newField) {
        report(
          'api-removed-field',
          'old',
          oldField.segments,
          `Response field "${fieldPath}" of ${label} (${oldResponse.status}) was removed. Clients that read it get undefined or fail to parse the response.`,
        );
      } else if (comparable(oldField.type, newField.type)) {
        report(
          'api-type-changed',
          'new',
          newField.segments,
          `Response field "${fieldPath}" of ${label} changed type from ${oldField.type} to ${newField.type}. Clients that parse it as ${oldField.type} break.`,
        );
      }
    }
  }

  if (oldPart.body && newPart.body) {
    const oldFields = flattenSchema(oldPart.document, oldPart.body.schema, oldPart.body.segments);
    const newFields = flattenSchema(newPart.document, newPart.body.schema, newPart.body.segments);
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
      } else if (oldField && comparable(oldField.type, newField.type)) {
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

  for (const [key, newParameter] of newPart.parameters) {
    const oldParameter = oldPart.parameters.get(key);
    if (newParameter.required && !oldParameter?.required) {
      report(
        'api-required-input',
        'new',
        newParameter.segments,
        `The ${newParameter.label} of ${label} is now required. Clients that omit it get a 400 response.`,
      );
    } else if (oldParameter && comparable(oldParameter.type, newParameter.type)) {
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

function operationParts(document, pathItem, operation, pathSegments, operationSegments) {
  return {
    document,
    responses: successResponses(document, operation, operationSegments),
    body: requestBodySchema(document, operation, operationSegments),
    parameters: parameterMap(document, pathItem, operation, pathSegments, operationSegments),
  };
}

// Returns findings { ruleId, side: 'old' | 'new', line, column, message }; `side` says which text the line is in.
function compareOpenApi(oldText, newText) {
  const oldDocument = JSON.parse(oldText);
  const newDocument = JSON.parse(newText);
  const locators = { old: createLocator(oldText), new: createLocator(newText) };
  const findings = [];
  for (const [pathName, oldItem] of Object.entries(oldDocument.paths ?? {})) {
    for (const method of httpMethods) {
      if (!oldItem?.[method]) continue;
      const label = `${method.toUpperCase()} ${pathName}`;
      const pathSegments = ['paths', pathName];
      const operationSegments = [...pathSegments, method];
      const report = (ruleId, side, segments, message) => {
        findings.push({ ruleId, side, ...locators[side](segments), message });
      };
      const newItem = newDocument.paths?.[pathName];
      if (!newItem?.[method]) {
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
        operationParts(oldDocument, oldItem, oldItem[method], pathSegments, operationSegments),
        operationParts(newDocument, newItem, newItem[method], pathSegments, operationSegments),
      );
    }
  }
  return findings;
}

module.exports = { compareOpenApi };
