// Rule id -> [code, note] for the rules that moved from the performance checker.
import type { RuleExamples } from '../types/rule-example.js';

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const examples: RuleExamples = {
  'drizzle-scope-unverified': [
    'const rows = await db.select().from(invoices).where(\n  and(filter, eq(invoices.organizationId, currentOrganization()))\n);',
    'Read example. Use the actual scoped property and trusted helper declared for your table. Preserve the predicate and ownership on writes.',
  ],
  'pg-dynamic-query-text': [
    "const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);",
    'Bind values as parameters. For dynamic identifiers or sort directions, choose among fixed, allowlisted SQL fragments.',
  ],
  'prisma-scope-unverified': [
    'const rows = await prisma.invoice.findMany({\n  where: { AND: [filter, { organizationId: currentOrganization() }] }\n});',
    'Read example. Substitute the field and trusted scope helper declared by your policy. Protected writes must also preserve ownership in their input data.',
  ],
};

export default examples;
