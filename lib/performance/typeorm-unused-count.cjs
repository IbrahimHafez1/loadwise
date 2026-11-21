'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { awaitedResult, outsideWrappers } = require('./query-results.cjs');
const { declaredInPackage } = require('./schema/ts-helpers.cjs');

const typeorm = ['typeorm'];
const methods = new Map([
  ['findAndCount', { owners: ['Repository'], replacement: 'find' }],
  ['findAndCountBy', { owners: ['Repository'], replacement: 'findBy' }],
  ['getManyAndCount', { owners: ['SelectQueryBuilder'], replacement: 'getMany' }],
]);

function check(call, context) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || ts.isOptionalChain(call)) return;
  const method = methods.get(access.name.text);
  if (!method) return;

  const awaited = awaitedResult(call);
  if (!awaited) return;
  const initializer = outsideWrappers(awaited);
  const binding = initializer.parent;
  if (
    !ts.isVariableDeclaration(binding) ||
    binding.initializer !== initializer ||
    !ts.isArrayBindingPattern(binding.name)
  )
    return;
  const [rows, ...remaining] = binding.name.elements;
  if (!rows || !ts.isBindingElement(rows) || !rows.name || rows.dotDotDotToken) return;
  if (remaining.some((element) => ts.isBindingElement(element) && element.name)) return;
  if (
    !context.isPackageType(access.expression, typeorm, method.owners) ||
    !declaredInPackage(access.name, context.checker, typeorm)
  )
    return;

  context.report(
    access.name,
    'typeorm-unused-count',
    `\`${access.name.text}\` may run a count query, but this destructuring only keeps the rows. Use \`${method.replacement}\` with the same filter and paging to avoid requesting a total.`,
  );
}

module.exports = { check };
