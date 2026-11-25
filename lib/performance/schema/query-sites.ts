import { prismaSite, prismaTableFor } from './query-sites-prisma.js';
import { drizzleSite } from './query-sites-drizzle.js';
import { typeormSite, repositoryEntity } from './query-sites-typeorm.js';
import { sequelizeSite } from './query-sites-sequelize.js';
import { mongooseSite } from './query-sites-mongoose.js';
import type { CallExpression } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { QuerySite } from '../types/query-site.js';

// A site is { orm, node, table (Prisma and TypeORM), conditions: [{ table, column, kind, node,
// operator?, expression? }], order, limited, uncertain }. Kinds: eq, in, range, null (IS NULL),
// other (cannot narrow by itself), pattern, expression.
// `uncertain` means a conjunct could not be read, so it might be the covered one: rules stay
// silent.

// The query this call starts, or undefined when it is not a recognized ORM read.
function querySite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  return (
    prismaSite(call, checker) ??
    drizzleSite(call, checker) ??
    typeormSite(call, checker) ??
    sequelizeSite(call, checker) ??
    mongooseSite(call, checker)
  );
}

export { querySite, prismaTableFor, repositoryEntity };
