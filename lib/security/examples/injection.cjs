'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'code-injection': [
    "const operations = { sum: (a, b) => a + b, max: Math.max };\nconst operation = operations[req.body.operation];\nif (!operation) throw new BadRequestException('Unknown operation');",
    'Map input to a fixed set of functions, or parse it as data, instead of evaluating it.',
  ],
  'command-injection': [
    "await execFile('convert', [file, 'out.png']);",
    'Without a shell, each array element reaches the program as one argument, so metacharacters stay literal.',
  ],
  'drizzle-sql-raw-dynamic': [
    'const SORT_COLUMNS = { name: users.name, created: users.createdAt };\nconst rows = await db.select().from(users).orderBy(SORT_COLUMNS[sort] ?? users.createdAt);',
    'Use the `sql` tag for values and choose columns from a fixed map; keep `sql.raw` for constant text.',
  ],
  'knex-raw-dynamic-text': [
    "const rows = await knex('users').whereRaw('lower(email) = ?', [email]).orderByRaw('?? desc', [column]);",
    'Bind values with `?` and identifiers with `??`; choose identifiers from an allowlist.',
  ],
  'mysql-dynamic-query-text': [
    "const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);",
    'Pass values as placeholders; choose table and column names from a fixed allowlist.',
  ],
  'nosql-operator-injection': [
    'const user = await User.findOne({ email: { $eq: req.body.email } });',
    '`$eq` matches the value literally, so an object such as `{ "$ne": null }` cannot change the query. Validating the body with a schema also works.',
  ],
  'prisma-raw-unsafe-dynamic': [
    'const users = await prisma.$queryRaw`SELECT id FROM "User" WHERE email = ${email}`;',
    'The tagged template binds each value. For dynamic identifiers, use `Prisma.sql` fragments chosen from an allowlist.',
  ],
  'sequelize-dynamic-query-text': [
    "const rows = await sequelize.query('SELECT id FROM users WHERE email = :email', {\n  replacements: { email },\n  type: QueryTypes.SELECT,\n});",
    'Pass values as `replacements` or `bind`; keep the SQL text constant.',
  ],
  'template-injection': [
    'const html = ejs.render(INVOICE_TEMPLATE, { name: req.body.name });',
    'Keep the template fixed and pass request data only in the data object.',
  ],
  'typeorm-dynamic-query-text': [
    "const users = await repo.createQueryBuilder('user')\n  .where('user.email = :email', { email })\n  .orderBy(SORT_COLUMNS[sort] ?? 'user.createdAt')\n  .getMany();",
    'Bind values as `:name` parameters and choose columns and directions from a fixed map.',
  ],
};
