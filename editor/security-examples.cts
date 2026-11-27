// Generic fix examples for security rules. Each group keeps its own [code, note] entries in
// lib/security/examples.
import movedExamples from '../lib/security/examples/moved.cjs';
import injectionExamples from '../lib/security/examples/injection.cjs';
import requestForgeryExamples from '../lib/security/examples/request-forgery.cjs';
import authCryptoExamples from '../lib/security/examples/auth-crypto.cjs';
import exposureExamples from '../lib/security/examples/exposure.cjs';
import depsExamples from '../lib/security/examples/deps.cjs';
import filesExamples from '../lib/security/examples/files.cjs';
import type { FixExample } from './types/fix-example.cjs';

const phase5Examples: Record<string, readonly string[]> = {
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
  'jwt-weak-secret-literal': [
    "const secret = process.env.JWT_SECRET;\nif (!secret) throw new Error('Missing JWT_SECRET');\nconst token = jwt.sign({ sub: userId }, secret, { expiresIn: '15m' });",
    'Load a high-entropy >= 256-bit secret from environment or KMS instead of a weak literal.',
  ],
  'graphql-batching-unbounded': [
    'const server = new ApolloServer({\n  typeDefs,\n  resolvers,\n  allowBatchedHttpRequests: true,\n  validationRules: [depthLimit(5)],\n});',
    'Enforce a batch size, query depth, or complexity limit whenever GraphQL batching is enabled.',
  ],
  'express-cookie-auth-missing-csrf': [
    "app.use(cookieParser());\napp.use(doubleCsrfProtection);\napp.post('/transfer', (req, res) => res.send('ok'));",
    'Enable CSRF middleware or `sameSite: "strict"` cookies for state-changing routes using cookie auth.',
  ],
};

const examples: Record<string, readonly string[]> = {
  ...movedExamples,
  ...injectionExamples,
  ...requestForgeryExamples,
  ...authCryptoExamples,
  ...exposureExamples,
  ...depsExamples,
  ...filesExamples,
  ...phase5Examples,
};

function exampleFor(ruleId: string, languageId: string): FixExample | undefined {
  if (!Object.hasOwn(examples, ruleId)) return;
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const [code, note] = examples[ruleId];
  return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', code, note };
}

export { exampleFor };
