// A parsed `schema.prisma`: its models as table models, plus what the rules need to resolve names.
import type { SchemaTable } from './schema-model.cjs';

export interface PrismaSchema {
  dialect: string | undefined;
  provider: string | undefined;
  models: Map<string, SchemaTable>;
  views: Set<string>;
  enums: Set<string>;
}
