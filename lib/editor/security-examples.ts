// Generic fix examples for security rules. Each group keeps its own [code, note] entries in
// lib/security/examples.
import movedModule from '../security/examples/moved.cjs';
import injectionModule from '../security/examples/injection.cjs';
import requestForgeryModule from '../security/examples/request-forgery.cjs';
import authCryptoModule from '../security/examples/auth-crypto.cjs';
import exposureModule from '../security/examples/exposure.cjs';
import depsModule from '../security/examples/deps.cjs';
import filesModule from '../security/examples/files.cjs';
import type { FixExample } from './types/fix-example.js';

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const phase5Examples: Record<string, readonly string[]> = {
  'express-cookie-auth-missing-csrf': [
    "app.use(cookieParser());\napp.use(doubleCsrfProtection);\napp.post('/transfer', (req, res) => res.send('ok'));",
    'Enable CSRF middleware or `sameSite: "strict"` cookies for state-changing routes using cookie auth.',
  ],
  'graphql-batching-unbounded': [
    'const server = new ApolloServer({\n  typeDefs,\n  resolvers,\n  allowBatchedHttpRequests: true,\n  validationRules: [depthLimit(5)],\n});',
    'Enforce a batch size, query depth, or complexity limit whenever GraphQL batching is enabled.',
  ],
  'jwt-weak-secret-literal': [
    "const secret = process.env.JWT_SECRET;\nif (!secret) throw new Error('Missing JWT_SECRET');\nconst token = jwt.sign({ sub: userId }, secret, { expiresIn: '15m' });",
    'Load a high-entropy >= 256-bit secret from environment or KMS instead of a weak literal.',
  ],
  'server-action-missing-auth': [
    "'use server';\nexport async function deleteAccount(id: string) {\n  const session = await auth();\n  if (!session) throw new Error('Unauthorized');\n  await db.user.delete({ where: { id } });\n}",
    'Verify the caller session before mutating state in a Server Action.',
  ],
  'ssrf-redirect-bypass': [
    "if (!isAllowedUrl(targetUrl)) throw new Error('Blocked');\nconst res = await fetch(targetUrl, { redirect: 'error' });",
    'Disable automatic HTTP redirects (`redirect: "error"` or `"manual"`) on dynamic outbound requests.',
  ],
  'vm-sandbox-escape': [
    "import ivm from 'isolated-vm';\nconst isolate = new ivm.Isolate({ memoryLimit: 32 });\nconst result = await isolate.compileScript(code).then((s) => s.run(isolate.createContextSync()));",
    'Replace `node:vm` / `vm2` with `isolated-vm` or an OS-level sandbox for untrusted code.',
  ],
};

const examples: Record<string, readonly string[]> = {
  ...movedModule.default,
  ...injectionModule.default,
  ...requestForgeryModule.default,
  ...authCryptoModule.default,
  ...exposureModule.default,
  ...depsModule.default,
  ...filesModule.default,
  ...phase5Examples,
};

function exampleFor(ruleId: string, languageId: string): FixExample | undefined {
  if (!Object.hasOwn(examples, ruleId)) return;
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const [code, note] = examples[ruleId];
  return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', code, note };
}

export { exampleFor };
