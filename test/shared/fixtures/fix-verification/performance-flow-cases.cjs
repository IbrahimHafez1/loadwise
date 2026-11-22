'use strict';

// Performance fix samples for await and promise ordering, taken from the matching rule tests.
function sample(ruleId, source, extraFiles = {}) {
  return { ruleId, files: { 'package.json': '{}', 'src.ts': source, ...extraFiles } };
}

const prismaUserFiles = {
  'node_modules/@prisma/client/index.d.ts': `export interface User { id: string; name: string }
export interface UserDelegate {
  findUnique(args: object): Promise<User | null>;
  findMany(args?: object): Promise<User[]>;
}
export declare class PrismaClient { user: UserDelegate }`,
};

const performanceFlowCases = [
  sample(
    'await-before-early-exit',
    `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function rename(id: string, name: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!name) throw new Error('name required');
  return { user, name };
}
`,
    prismaUserFiles,
  ),
  sample(
    'promise-return-escapes-catch',
    `export async function respond(load: () => Promise<string>) {
  try {
    return load();
  } catch {
    return 'handled';
  }
}
`,
  ),
];

module.exports = { performanceFlowCases };
