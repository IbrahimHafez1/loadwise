// client-env-secret-exposed: a secret-named environment variable read under a prefix the build
// inlines into the browser bundle (`process.env.NEXT_PUBLIC_*`, `import.meta.env.VITE_*`,
// `$env/static/public`). The prefix, not the code that reads it, decides the exposure, so the
// variable is public wherever it is read; only its name is reported, never a value.
import { ts } from '../../performance/compiler.js';
import { unwrap } from './literals.js';
import type { ElementAccessExpression, Expression, ImportSpecifier, Node, PropertyAccessExpression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'client-env-secret-exposed';
// Next.js, Create React App, Expo and Nuxt inline these from `process.env`.
const processEnvPrefixes = ['NEXT_PUBLIC_', 'REACT_APP_', 'EXPO_PUBLIC_', 'NUXT_PUBLIC_'];
// Vite, and Astro and SvelteKit (both on Vite), expose these on `import.meta.env`.
const importMetaEnvPrefixes = ['VITE_', 'PUBLIC_'];
const svelteKitPublicModules = new Set(['$env/static/public', '$env/dynamic/public']);
const svelteKitPublicPrefix = 'PUBLIC_';
// The secret word must end the name: `..._DISABLE_PASSWORD_LOGIN` is a flag, `..._PASSWORD` a value.
// Publishable, anon, public, site keys, DSNs and client ids end in other words and stay clean.
const secretNameEnding =
  /(?:^|_)(?:SECRET(?:_KEY|_TOKEN|_ACCESS_KEY)?|PASSWORD|PASSWD|PRIVATE_KEY|SERVICE_ROLE(?:_KEY)?|SERVICE_ACCOUNT_KEY|DATABASE_URL)$/;

function exposedPrefix(name: string, prefixes: readonly string[]) {
  return prefixes.find((prefix) => name.startsWith(prefix) && secretNameEnding.test(name.slice(prefix.length)));
}

function report(node: Node, name: string, prefix: string, context: SecurityRuleContext) {
  context.report(
    node,
    ruleId,
    `\`${name}\` is a secret-named variable with the browser-exposed \`${prefix}\` prefix, so the build inlines its value into the client bundle where anyone can read it. Keep the secret on the server under a name without the public prefix, and rotate it if it has shipped.`,
  );
}

function isProcessEnv(receiver: Expression) {
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== 'env') return false;
  const root = unwrap(receiver.expression);
  return ts.isIdentifier(root) && root.text === 'process';
}

function isImportMetaEnv(receiver: Expression) {
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== 'env') return false;
  const meta = unwrap(receiver.expression);
  return ts.isMetaProperty(meta) && meta.keywordToken === ts.SyntaxKind.ImportKeyword && meta.name.text === 'meta';
}

// `env` in `import { env } from '$env/dynamic/public'`.
function isSvelteKitPublicEnv(receiver: Expression, context: SecurityRuleContext) {
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = context.checker.getSymbolAtLocation(receiver)?.declarations?.[0];
  return declaration !== undefined && ts.isImportSpecifier(declaration) && importedFromSvelteKitPublic(declaration);
}

function importedFromSvelteKitPublic(specifier: ImportSpecifier) {
  const moduleSpecifier = specifier.parent.parent.parent.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) && svelteKitPublicModules.has(moduleSpecifier.text);
}

function prefixesFor(receiver: Expression, context: SecurityRuleContext) {
  if (isProcessEnv(receiver)) return processEnvPrefixes;
  if (isImportMetaEnv(receiver)) return importMetaEnvPrefixes;
  return isSvelteKitPublicEnv(receiver, context) ? [svelteKitPublicPrefix] : undefined;
}

// `process.env[name]` with a variable key names nothing the build can inline.
function envKeyName(node: PropertyAccessExpression | ElementAccessExpression) {
  if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.name) ? node.name.text : undefined;
  const key = unwrap(node.argumentExpression);
  return ts.isStringLiteralLike(key) ? key.text : undefined;
}

function checkEnvRead(node: PropertyAccessExpression | ElementAccessExpression, context: SecurityRuleContext) {
  const name = envKeyName(node);
  if (name === undefined) return;
  const prefixes = prefixesFor(unwrap(node.expression), context);
  const prefix = prefixes && exposedPrefix(name, prefixes);
  if (prefix) report(node, name, prefix, context);
}

// `import { PUBLIC_STRIPE_SECRET_KEY } from '$env/static/public'`.
function checkImportSpecifier(specifier: ImportSpecifier, context: SecurityRuleContext) {
  if (!importedFromSvelteKitPublic(specifier)) return;
  const name = (specifier.propertyName ?? specifier.name).text;
  const prefix = exposedPrefix(name, [svelteKitPublicPrefix]);
  if (prefix) report(specifier, name, prefix, context);
}

export { checkEnvRead, checkImportSpecifier };
