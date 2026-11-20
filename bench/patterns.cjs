'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const WARMUP_PAIRS = 3;
const SAMPLE_PAIRS = 12;

function median(samples) {
  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compare(title, variants) {
  const expected = variants[0].run();
  const samples = variants.map(() => []);
  for (let pair = 0; pair < WARMUP_PAIRS + SAMPLE_PAIRS; pair++) {
    const order = pair % 2 ? [1, 0] : [0, 1];
    for (const index of order) {
      const start = performance.now();
      const result = variants[index].run();
      const elapsed = performance.now() - start;
      assert.deepStrictEqual(result, expected);
      if (pair >= WARMUP_PAIRS) samples[index].push(elapsed);
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(expected)).digest('hex').slice(0, 16);
  console.log(`\n${title} (${expected.length} results, SHA-256 prefix ${digest})`);
  for (let index = 0; index < variants.length; index++) {
    console.log(`  ${variants[index].label}: ${median(samples[index]).toFixed(3)} ms median`);
  }
}

function benchmarkQueries(database) {
  const TOTAL_CUSTOMERS = 900;
  const CUSTOMER_PAGE_SIZE = 300;
  const ORDERS_PER_CUSTOMER = 4;
  database.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);
    CREATE INDEX orders_by_customer ON orders(customer_id, id);
  `);
  const insertCustomer = database.prepare('INSERT INTO customers VALUES (?)');
  const insertOrder = database.prepare('INSERT INTO orders(customer_id) VALUES (?)');
  database.exec('BEGIN');
  for (let customerId = 1; customerId <= TOTAL_CUSTOMERS; customerId++) {
    insertCustomer.run(customerId);
    // Include customers who have never placed an order.
    if (customerId % 7 === 0) continue;
    for (let i = 0; i < ORDERS_PER_CUSTOMER; i++) insertOrder.run(customerId);
  }
  database.exec('COMMIT');
  const customers = database.prepare('SELECT id FROM customers ORDER BY id LIMIT ?');
  const single = database.prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY id');
  const placeholders = Array(CUSTOMER_PAGE_SIZE).fill('?').join(', ');
  const batch = database.prepare(`
    SELECT customer_id, id FROM orders WHERE customer_id IN (${placeholders}) ORDER BY customer_id, id
  `);
  let statementCount = 0;
  function read(statement, ...parameters) {
    statementCount++;
    return statement.all(...parameters);
  }
  function perCustomer() {
    return read(customers, CUSTOMER_PAGE_SIZE).map(({ id }) => ({
      id,
      orders: read(single, id).map((order) => order.id),
    }));
  }
  function batched() {
    const page = read(customers, CUSTOMER_PAGE_SIZE);
    const ordersByCustomer = new Map(page.map(({ id }) => [id, []]));
    for (const order of read(batch, ...ordersByCustomer.keys())) {
      ordersByCustomer.get(order.customer_id).push(order.id);
    }
    return page.map(({ id }) => ({ id, orders: ordersByCustomer.get(id) }));
  }
  const variants = [
    { label: 'Query per customer', run: perCustomer },
    { label: 'Batched child query', run: batched },
  ];
  for (const variant of variants) {
    statementCount = 0;
    variant.run();
    variant.label += ` (${statementCount} statements per page)`;
  }
  compare(`In-memory SQLite, ${CUSTOMER_PAGE_SIZE} customers per page`, variants);

  const orderedOrders = 'SELECT customer_id, id FROM orders WHERE customer_id >= ? ORDER BY customer_id DESC, id DESC';
  const allMatches = database.prepare(orderedOrders);
  const firstMatch = database.prepare(orderedOrders + ' LIMIT 1');
  const minimumCustomerIds = [1, TOTAL_CUSTOMERS + 1];
  const materializedRows = minimumCustomerIds.reduce((total, id) => total + allMatches.all(id).length, 0);
  compare('First matching order, including an empty result', [
    {
      label: `Read ${materializedRows} rows and keep the first match`,
      run: () => minimumCustomerIds.map((id) => allMatches.all(id)[0]),
    },
    {
      label: 'Ordered LIMIT 1 (one row returned across both lookups)',
      run: () => minimumCustomerIds.map((id) => firstMatch.all(id)[0]),
    },
  ]);
}

function benchmarkCollections() {
  const ALLOWED_COUNT = 8_000;
  const REQUEST_COUNT = 12_000;
  const allowed = Array.from({ length: ALLOWED_COUNT }, (_, index) => index * 2);
  const requested = Array.from({ length: REQUEST_COUNT }, (_, index) => index);
  compare(`Membership, ${ALLOWED_COUNT} allowed IDs and ${REQUEST_COUNT} lookups`, [
    { label: 'Array.includes for each ID', run: () => requested.filter((id) => allowed.includes(id)) },
    {
      label: 'Build Set and test each ID',
      run() {
        const allowedIds = new Set(allowed);
        return requested.filter((id) => allowedIds.has(id));
      },
    },
  ]);

  const VALUE_COUNT = 4_000;
  const values = Array.from({ length: VALUE_COUNT }, (_, index) => index);
  compare(`Collecting ${VALUE_COUNT} transformed IDs`, [
    { label: 'Copy growing accumulator', run: () => values.reduce((result, id) => [...result, id * 2], []) },
    {
      label: 'Append to private accumulator',
      run() {
        const result = [];
        for (const id of values) result.push(id * 2);
        return result;
      },
    },
  ]);
}

console.log(`Node ${process.version}; ${WARMUP_PAIRS} warm-up pairs, ${SAMPLE_PAIRS} alternating sample pairs.`);
console.log(
  'Local elapsed time includes result construction. SQLite uses prepared statements and an in-memory database.',
);
const database = new DatabaseSync(':memory:');
try {
  benchmarkQueries(database);
} finally {
  database.close();
}
benchmarkCollections();
