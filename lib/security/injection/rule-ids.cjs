'use strict';

// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types'; see bindings.cjs).
module.exports = {
  'command-injection': { needs: 'import' },
  'drizzle-sql-raw-dynamic': { needs: 'import' },
  'knex-raw-dynamic-text': { needs: 'import' },
  'mysql-dynamic-query-text': { needs: 'import' },
  'nosql-operator-injection': { needs: 'import' },
  'prisma-raw-unsafe-dynamic': { needs: 'syntax' },
  'sequelize-dynamic-query-text': { needs: 'import' },
  'typeorm-dynamic-query-text': { needs: 'import' },
};
