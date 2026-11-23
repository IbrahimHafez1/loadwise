'use strict';

// Performance fix samples for the transaction-escape and json-parse builders.
const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export declare class Repository<Entity> {
  save(entity: Entity): Promise<Entity>;
}
export declare class EntityManager {
  query(sql: string): Promise<unknown>;
  save<Entity>(entity: Entity): Promise<Entity>;
  withRepository<Entity>(repository: Repository<Entity>): Repository<Entity>;
  transaction<Result>(run: (manager: EntityManager) => Promise<Result>): Promise<Result>;
}
export declare class DataSource extends EntityManager {
  manager: EntityManager;
}`,
};

const performanceAddedCases = [
  {
    ruleId: 'typeorm-transaction-client-escape',
    files: {
      'package.json': '{}',
      'src.ts': `import { DataSource, Repository } from 'typeorm';
declare const dataSource: DataSource;
declare const users: Repository<{ id: number }>;
export async function run() {
  await dataSource.transaction(async (manager) => {
    await manager.query('select 1');
    await users.save({ id: 1 });
  });
}
`,
      ...typeormFiles,
    },
  },
  {
    ruleId: 'json-parse-unguarded',
    files: {
      'package.json': '{}',
      'src.ts': `declare const express: { get(path: string, handler: (request: { query: { filter: string } }, response: { status(code: number): { json(body: object): void } }) => void): void };
express.get('/items', (request, response) => {
  const filter = JSON.parse(request.query.filter);
  response.status(200).json({ filter });
});
`,
    },
  },
  {
    ruleId: 'return-in-finally',
    files: {
      'package.json': '{}',
      'src.ts': `declare function flush(): Promise<void>;
export async function close(): Promise<void> {
  try {
    await flush();
  } finally {
    console.info('closed');
    return;
  }
}
`,
    },
  },
  {
    ruleId: 'floating-promise',
    files: {
      'package.json': '{}',
      'src.ts': `declare function save(id: string): Promise<void>;
export async function run(ids: string[]) {
  ids.forEach(async (id) => {
    await save(id);
  });
}
`,
    },
  },
];

module.exports = { performanceAddedCases };
