'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, defaultFindingsOf } = require('./exposure-helpers.cjs');

const ruleId = 'graphql-introspection-enabled';
const declarations = [
  'declare const GraphQLModule: any; declare class ApolloServer { constructor(options: object); }',
  'declare const createYoga: any; declare const app: any; declare const mercurius: any; declare const graphqlHTTP: any;',
  'declare const typeDefs: string; declare const driver: unknown; declare const schema: unknown; declare const enabled: boolean;',
  '',
].join('\n');

test('a literal true for introspection, playground or graphiql in a server config is reported', () => {
  const sources = [
    'new ApolloServer({ typeDefs, introspection: true });',
    'GraphQLModule.forRoot({ driver, playground: true });',
    'GraphQLModule.forRootAsync({ useFactory: () => ({ introspection: true }) });',
    'GraphQLModule.forRootAsync({ useFactory: async () => { return { playground: true }; } });',
    'createYoga({ schema, graphiql: true });',
    'app.register(mercurius, { schema, graphiql: true });',
    'app.use("/graphql", graphqlHTTP({ schema, graphiql: true }));',
  ];
  for (const line of sources) assert.equal(defaultFindingsOf(ruleId, declarations + line).length, 1, line);
});

test('non-literal values, false, absent options and other objects are clean', () => {
  const clean = [
    "new ApolloServer({ introspection: process.env.NODE_ENV !== 'production' });",
    'new ApolloServer({ introspection: false });',
    'new ApolloServer({ typeDefs });',
    'GraphQLModule.forRoot({ playground: enabled });',
    'const settings = { introspection: true }; settings.introspection;',
    'createYoga({ schema, graphiql: { title: "x" } });',
    'GraphQLModule.forRootAsync({ useFactory: () => { const unused = { playground: true }; return {}; } });',
  ];
  for (const line of clean) assert.equal(findingsOf(ruleId, declarations + line).length, 0, line);
});

test('a literal true under a non-production check is contextual', () => {
  const source = `${declarations}if (process.env.NODE_ENV !== 'production') { new ApolloServer({ introspection: true }); }`;
  const findings = findingsOf(ruleId, source);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});
