import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.cjs';

const ruleId = 'graphql-query-depth-unbounded';
const declarations = [
  'declare const GraphQLModule: any; declare class ApolloServer { constructor(options: object); }',
  'declare const createYoga: any; declare const app: any; declare const mercurius: any; declare const graphqlHTTP: any;',
  'declare const typeDefs: string; declare const driver: unknown; declare const schema: unknown; declare const depthLimit: any;',
  'declare const useDepthLimit: any; declare const options: any;',
  '',
].join('\n');

test('a server options literal with no depth or cost limit is reported', () => {
  const sources = [
    'new ApolloServer({ typeDefs });',
    'GraphQLModule.forRoot({ driver, autoSchemaFile: true });',
    'createYoga({ schema });',
    'app.register(mercurius, { schema });',
    'app.use("/graphql", graphqlHTTP({ schema, graphiql: false }));',
    'const config = { typeDefs }; new ApolloServer(config);',
  ];
  for (const line of sources) assert.equal(defaultFindingsOf(ruleId, declarations + line).length, 1, line);
});

test('a configured limit keeps the server clean', () => {
  const clean = [
    'new ApolloServer({ typeDefs, validationRules: [depthLimit(7)] });',
    'createYoga({ schema, plugins: [useDepthLimit({ maxDepth: 8 })] });',
    'app.register(mercurius, { schema, queryDepth: 8 });',
    'GraphQLModule.forRoot({ driver, validationRules: [createComplexityLimitRule(1000)] });',
    'app.use("/graphql", graphqlHTTP({ schema, validationRules: [depthLimit(5)] }));',
    'new ApolloServer({ typeDefs, plugins: [...armor.protect().plugins] });',
  ];
  for (const line of clean) assert.equal(findingsOf(ruleId, declarations + line).length, 0, line);
});

test('unseen options, spreads and factories are contextual only', () => {
  const contextual = [
    'new ApolloServer(options);',
    'new ApolloServer({ typeDefs, ...options });',
    'GraphQLModule.forRootAsync({ useFactory: () => ({ driver }) });',
    'app.register(mercurius, options);',
  ];
  for (const line of contextual) {
    const source = declarations + line;
    assert.equal(findingsOf(ruleId, source).length, 1, line);
    assert.equal(defaultFindingsOf(ruleId, source).length, 0, line);
  }
});

test('a project that imports a depth limit library elsewhere is contextual only', () => {
  const files = { 'limits.ts': "import depthLimit from 'graphql-depth-limit'; export default depthLimit;" };
  const source = `${declarations}new ApolloServer({ typeDefs });`;
  assert.equal(findingsOf(ruleId, source, files).length, 1);
  assert.equal(defaultFindingsOf(ruleId, source, files).length, 0);
});

test('other constructors and calls are ignored', () => {
  const clean = ['new Map({ typeDefs });', 'app.register(other, { schema });', 'createClient({ schema });'];
  for (const line of clean)
    assert.equal(
      findingsOf(ruleId, `${declarations}declare const other: any; declare const createClient: any;\n${line}`).length,
      0,
      line,
    );
});
