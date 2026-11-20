'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

test('find reports strict equality joins keyed by destructured iteration bindings', () => {
  const findings = lint(
    [
      'function enrich(orders: {customerId: string}[], customers: readonly {id: string}[]) {',
      '  orders.map(({customerId}) => customers.find(customer => customer.id === customerId));',
      '  for (const {customerId} of orders) {',
      '    customers.find(customer => customer.id === customerId);',
      '  }',
      '  const fixed = "a";',
      '  orders.map(({customerId}) => customers.find(customer => customer.id === fixed));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['array-repeated-find', 2],
      ['array-repeated-find', 4],
    ],
  );
});
