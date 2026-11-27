const { ApolloServer } = require('@apollo/server');

const server = new ApolloServer({
  typeDefs: 'type Query { ok: Boolean }',
  resolvers: { Query: { ok: () => true } },
  allowBatchedHttpRequests: true,
});

module.exports = { server };
