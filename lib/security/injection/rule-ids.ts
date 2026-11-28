// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types';
// see bindings.cjs).
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
export default {
  'code-injection': { needs: 'syntax' },
  'command-injection': { needs: 'import' },
  'drizzle-sql-raw-dynamic': { needs: 'import' },
  'knex-raw-dynamic-text': { needs: 'import' },
  'mysql-dynamic-query-text': { needs: 'import' },
  'nosql-operator-injection': { needs: 'import' },
  'prisma-raw-unsafe-dynamic': { needs: 'syntax' },
  'regex-catastrophic-backtracking': { needs: 'syntax' },
  'regex-from-input': { needs: 'syntax' },
  'sequelize-dynamic-query-text': { needs: 'import' },
  'template-injection': { needs: 'import' },
  'typeorm-dynamic-query-text': { needs: 'import' },
};
