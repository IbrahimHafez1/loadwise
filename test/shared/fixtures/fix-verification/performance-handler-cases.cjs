'use strict';

// Performance fix samples for loop, callback and request-handler builders that had no verification sample before.
const { validateParallelReads } = require('../../../../lib/performance/parallel-reads.cjs');

function sample(ruleId, files, policy) {
  return { ruleId, files: { 'package.json': '{}', ...files }, policy };
}

const firebaseFiles = {
  'node_modules/firebase-admin/index.d.ts': `export interface Message { token: string; android?: { priority?: 'high' | 'normal' } }
export class Messaging { send(message: Message): Promise<string>; sendEach(messages: Message[]): Promise<unknown> }
export function messaging(): Messaging;`,
};

const lookupService = `import { Repository } from 'typeorm';
export class LookupService {
  constructor(private grades: Repository<{ id: string; stageId: string; schoolId: string }>) {}

  async findGrade(id: string) {
    return this.grades.findOne({ where: { id } });
  }
}
`;
const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  find(options: object): Promise<T[]>;
  findOne(options: object): Promise<T | null>;
}
export declare function In<T>(values: T[]): T;`,
};

const performanceHandlerCases = [
  sample('notification-send-in-loop', {
    'src/service.ts': `import { messaging } from 'firebase-admin';
export async function run(devices: { token: string }[]) {
  for (const device of devices) {
    await messaging().send({ token: device.token, android: { priority: 'high' } });
  }
}
`,
    ...firebaseFiles,
  }),
  sample('service-query-in-loop', {
    'src/lookup.ts': lookupService,
    'src/main.ts': `import { LookupService } from './lookup.js';
export class Report {
  constructor(private lookup: LookupService) {}
  async names(items: { gradeId: string }[]) {
    const names: string[] = [];
    for (const item of items) {
      const grade = await this.lookup.findGrade(item.gradeId);
      if (grade) names.push(grade.id);
    }
    return names;
  }
}
`,
    ...typeormFiles,
  }),
  sample('async-callback-unhandled-rejection', {
    'src/timer.ts': `declare function load(): Promise<string>;
setTimeout(async () => {
  await load();
}, 1000);
`,
  }),
  sample('request-number-unvalidated', {
    'src/route.ts': `declare const db: { user: { findMany(options: object): Promise<unknown[]> } };
export async function list(req: { query: { page: string } }, res: { json(body: unknown): void; status(code: number): { json(body: object): void } }) {
  const page = Number(req.query.page);
  res.json(await db.user.findMany({ skip: page * 20, take: 20 }));
}
`,
  }),
  sample('repeated-workbook-decode', {
    'src/reader.ts': `type Upload = { buffer: Uint8Array };
export class Reader {
  private async first(file: Upload) {
    const Excel = await import('exceljs');
    const book = new Excel.Workbook();
    await book.xlsx.load(file.buffer);
    return book.getWorksheet('Users').name;
  }
  private async second(file: Upload) {
    const Excel = await import('exceljs');
    const book = new Excel.Workbook();
    await book.xlsx.load(file.buffer);
    return book.getWorksheet('Orders').name;
  }
  async run(file: Upload) {
    const first = await this.first(file);
    const second = await this.second(file);
    return [first, second];
  }
}
`,
    'node_modules/exceljs/package.json':
      '{"name":"exceljs","main":"index.js","types":"index.d.ts","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}',
    'node_modules/exceljs/index.d.ts':
      'export class Workbook { xlsx: { load(bytes: Uint8Array): Promise<void> }; getWorksheet(name: string): { name: string } }',
  }),
  sample('external-call-in-transaction', {
    'src/transfer.ts': `import { DataSource } from 'typeorm';
declare const dataSource: DataSource;
export async function run(id: number) {
  await dataSource.transaction(async (manager) => {
    await manager.query('select 1');
    await fetch(String(id));
  });
}
`,
    'node_modules/typeorm/index.d.ts': `export class EntityManager {
  query(sql: string): Promise<unknown>;
  transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
}
export class DataSource extends EntityManager {}`,
  }),
  sample('guard-query-per-request', {
    'src/guard.ts': `import { CanActivate, Injectable, APP_GUARD } from '@nestjs/common';
import { Repository } from 'typeorm';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly users: Repository<{ id: number; active: boolean }>) {}

  private ready(context: { ids: number[] }) {
    return context.ids.length > 0;
  }

  async canActivate(context: { userId: number; ids: number[] }) {
    if (!this.ready(context)) return false;
    const user = await this.users.findOne({ where: { id: context.userId }, select: { active: true } });
    return Boolean(user?.active);
  }
}
export const providers = [{ provide: APP_GUARD, useClass: SessionGuard }];
`,
    'node_modules/@nestjs/common/index.d.ts': `export interface CanActivate { canActivate(context: unknown): boolean | Promise<boolean>; }
export declare function Injectable(): ClassDecorator;
export declare const APP_GUARD: string;`,
    'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findOne(options?: object): Promise<T | null>;
}`,
  }),
  sample(
    'known-reads-awaited-serially',
    {
      'src/dashboard.ts': `import { fetchUser, fetchPosts } from '@app/reads';
export async function dashboard(id: string) {
  const user = await fetchUser(id);
  const posts = await fetchPosts(id);
  return { user, posts };
}
`,
      'node_modules/@app/reads/index.d.ts': `export function fetchUser(id?: string): Promise<string>;
export function fetchPosts(id?: string): Promise<string>;`,
    },
    { parallelReads: validateParallelReads([{ from: '@app/reads', exports: ['fetchUser', 'fetchPosts'] }]) },
  ),
];

module.exports = { performanceHandlerCases };
