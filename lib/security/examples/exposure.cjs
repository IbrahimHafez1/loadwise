'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'cookie-missing-security-flags': [
    "res.cookie('session', token, {\n  httpOnly: true,\n  secure: process.env.NODE_ENV === 'production',\n  sameSite: 'lax',\n});",
    'httpOnly keeps scripts from reading the cookie, secure limits it to HTTPS and sameSite limits cross-site sends.',
  ],
  'cors-credentials-any-origin': [
    "app.use(cors({\n  origin: ['https://app.example.com'],\n  credentials: true,\n}));",
    'Name the origins that may send credentials. Read them from configuration when they differ per environment.',
  ],
  'cors-origin-regex-unanchored': [
    'app.use(cors({\n  origin: /^https:\\/\\/(?:[\\w-]+\\.)*example\\.com$/,\n  credentials: true,\n}));',
    'Start the host after `//` or a dot, escape its dots and end it with `$`, so look-alike hosts such as evilexample.com do not match.',
  ],
  'error-stack-in-response': [
    "logger.error(err);\nres.status(500).json({ message: 'Internal server error' });",
    'Log the error on the server and return a generic message. Return err.message only when it is written for clients.',
  ],
  'graphql-introspection-enabled': [
    "new ApolloServer({\n  typeDefs,\n  introspection: process.env.NODE_ENV !== 'production',\n});",
    'Turn introspection and the playground on only outside production.',
  ],
  'mass-assignment': [
    'await prisma.user.create({\n  data: { name: body.name, email: body.email },\n});',
    'Copy the fields callers may set, or parse the body with a schema that strips unknown keys.',
  ],
  'nest-validation-without-whitelist': [
    'app.useGlobalPipes(new ValidationPipe({\n  whitelist: true,\n  forbidNonWhitelisted: true,\n}));',
    'whitelist strips properties without a validation decorator; forbidNonWhitelisted rejects the request instead.',
  ],
  'prototype-pollution': [
    "const blocked = new Set(['__proto__', 'constructor', 'prototype']);\nif (blocked.has(key)) throw new Error('Invalid key');\ntarget[key] = value;",
    'Reject the keys that reach the prototype, or copy only fields you list.',
  ],
  'reflected-xss-response': [
    'res.send(`<p>Hello ${escapeHtml(req.query.name)}</p>`);',
    'Escape values placed in HTML (escape-html, he), or return JSON.',
  ],
  'secret-in-log': [
    'logger.info({ userId: user.id, tokenId: token.id });',
    'Log an identifier or a redacted value, never the secret itself.',
  ],
  'template-autoescape-disabled': [
    "nunjucks.configure('views', { autoescape: true });\nswig.setDefaults({ autoescape: true });",
    "Leave escaping on and mark a trusted value with the engine's safe filter or triple braces, one value at a time.",
  ],
  'xml-external-entities': [
    'const document = parseXml(xml);',
    'Call the parser without noent and dtdload so external entities are not loaded.',
  ],
};
