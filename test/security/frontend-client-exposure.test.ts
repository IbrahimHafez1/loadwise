import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { withProgram } from '../performance/helpers.js';
import { createAnalyzer } from '../../lib/security/analyze.js';
import { checks } from '../../lib/security/exposure/index.js';
import type { ProgramAdapter } from '../../lib/shared/types.js';

const analyzeFile = createAnalyzer([{ checks }]);
const compilerOptions = { lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], jsx: ts.JsxEmit.Preserve };

const stubs = {
  react: {
    'node_modules/@types/react/index.d.ts':
      'declare global { namespace JSX { interface IntrinsicElements { [name: string]: any } } }\nexport {};',
  },
  nextNavigation: {
    'node_modules/next/navigation.d.ts':
      'export declare function useSearchParams(): { get(name: string): string | null };\nexport declare function useRouter(): { push(url: string): void };',
  },
  nextRouter: {
    'node_modules/next/router.d.ts':
      'export declare function useRouter(): { query: Record<string, string | string[] | undefined> };',
  },
  nextLink: {
    'node_modules/next/link.d.ts':
      'declare function Link(props: { href: string; children?: unknown }): unknown;\nexport default Link;',
  },
  reactRouter: {
    'node_modules/react-router-dom/index.d.ts':
      'export declare function useSearchParams(): [{ get(name: string): string | null }, (value: string) => void];',
  },
};

function findingsOf(ruleId: string, source: string, files: Record<string, string> = {}, fileName = 'main.ts') {
  return withProgram(
    fileName === 'main.ts' ? source : '',
    { ...(fileName === 'main.ts' ? {} : { [fileName]: source }), ...files },
    (program: ProgramAdapter) => {
      assert.ok(program.getSourceFiles);
      const sourceFile = program
        .getSourceFiles()
        .find((file) => file.fileName.replaceAll('\\', '/').endsWith(`/${fileName}`));
      assert.ok(sourceFile);
      return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === ruleId);
    },
    compilerOptions,
  );
}

const processDeclaration = 'declare const process: { env: Record<string, string | undefined> };\n';

test('client-env-secret-exposed: secret-named variables under a browser prefix are reported', () => {
  const sources = [
    'const key = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;',
    "const key = process.env['NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'];",
    'const password = process.env.REACT_APP_ADMIN_PASSWORD;',
    'const secret = process.env.EXPO_PUBLIC_CLIENT_SECRET;',
    'const url = process.env.NUXT_PUBLIC_DATABASE_URL;',
    'const key = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;',
    'const key = import.meta.env.VITE_JWT_PRIVATE_KEY;',
    'const key = import.meta.env.PUBLIC_API_SECRET;',
  ];
  for (const source of sources) {
    const found = findingsOf('client-env-secret-exposed', processDeclaration + source);
    assert.equal(found.length, 1, source);
    assert.equal(found[0].contextualReason, undefined, source);
  }
});

test('client-env-secret-exposed: the message names the variable and prefix only', () => {
  const [finding] = findingsOf(
    'client-env-secret-exposed',
    processDeclaration + 'const key = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;',
  );
  assert.match(
    finding.message,
    /^`NEXT_PUBLIC_STRIPE_SECRET_KEY` is a secret-named variable with the browser-exposed `NEXT_PUBLIC_` prefix/,
  );
});

test('client-env-secret-exposed: SvelteKit public env imports', () => {
  const staticImport =
    "import { PUBLIC_STRIPE_SECRET_KEY } from '$env/static/public';\nexport const key = PUBLIC_STRIPE_SECRET_KEY;";
  const dynamicImport = "import { env } from '$env/dynamic/public';\nexport const key = env.PUBLIC_DB_PASSWORD;";
  assert.equal(findingsOf('client-env-secret-exposed', staticImport).length, 1);
  assert.equal(findingsOf('client-env-secret-exposed', dynamicImport).length, 1);
  const privateImport =
    "import { STRIPE_SECRET_KEY } from '$env/static/private';\nexport const key = STRIPE_SECRET_KEY;";
  assert.equal(findingsOf('client-env-secret-exposed', privateImport).length, 0);
});

test('client-env-secret-exposed: publishable, anon and public keys, flags and server-only names are clean', () => {
  const sources = [
    'process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;',
    'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;',
    'process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;',
    'process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;',
    'process.env.NEXT_PUBLIC_SENTRY_DSN;',
    'process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID;',
    'process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;',
    'process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;',
    'process.env.NEXT_PUBLIC_DISABLE_PASSWORD_LOGIN;',
    'process.env.NEXT_PUBLIC_SECRET_SANTA_URL;',
    'process.env.STRIPE_SECRET_KEY;',
    'process.env.SUPABASE_SERVICE_ROLE_KEY;',
    'process.env.VITE_STRIPE_SECRET_KEY;',
    'import.meta.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;',
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;',
    'const config = { env: { NEXT_PUBLIC_STRIPE_SECRET_KEY: 1 } };\nconfig.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;',
  ];
  for (const source of sources)
    assert.equal(findingsOf('client-env-secret-exposed', processDeclaration + source).length, 0, source);
});

const reactHeader = "import * as React from 'react';\n";
const react18 = { dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' } };
const urlStubs = {
  ...stubs.react,
  ...stubs.nextNavigation,
  ...stubs.nextRouter,
  ...stubs.nextLink,
  ...stubs.reactRouter,
};

// jsx-javascript-url reads the project's package.json from disk, so these fixtures are real files.
function urlFindingsOf(source: string, manifest: object | null = react18) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-jsx-url-'));
  try {
    const files: Record<string, string> = { ...urlStubs, 'view.tsx': source };
    if (manifest) files['package.json'] = JSON.stringify(manifest);
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const viewFile = path.join(directory, 'view.tsx');
    const program = ts.createProgram([viewFile], {
      ...compilerOptions,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      noEmit: true,
    });
    const sourceFile = program.getSourceFile(viewFile);
    assert.ok(sourceFile);
    return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === 'jsx-javascript-url');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('jsx-javascript-url: untrusted values that start a link, form action or frame src are reported', () => {
  const sources = [
    `${reactHeader}export const View = () => <a href={location.hash.slice(1)}>Go</a>;`,
    `${reactHeader}const target = new URLSearchParams(location.search).get('next');\nexport const View = () => <a href={target ?? '/'}>Go</a>;`,
    `${reactHeader}export const View = () => <form action={decodeURIComponent(window.location.hash.substring(1))} />;`,
    `${reactHeader}export const View = () => <iframe src={location.hash.slice(1)} />;`,
    `${reactHeader}import { useSearchParams } from 'next/navigation';\nexport function View() { const params = useSearchParams(); return <a href={params.get('callbackUrl') || '/'}>Back</a>; }`,
    `${reactHeader}import { useSearchParams } from 'react-router-dom';\nexport function View() { const [params] = useSearchParams(); const next = params.get('next'); return <button formAction={next ?? ''} />; }`,
    `${reactHeader}import { useRouter } from 'next/router';\nexport function View() { const router = useRouter(); return <a href={String(router.query.redirect)}>Back</a>; }`,
    `${reactHeader}import Link from 'next/link';\nimport { useSearchParams } from 'next/navigation';\nexport function View() { const params = useSearchParams(); return <Link href={params.get('next') ?? '/'}>Back</Link>; }`,
  ];
  for (const source of sources) {
    const found = urlFindingsOf(source);
    assert.equal(found.length, 1, source);
    assert.equal(found[0].contextualReason, undefined, source);
  }
});

test('jsx-javascript-url: constant prefixes, own addresses, props, fetched data and checked URLs are clean', () => {
  const sources = [
    `${reactHeader}export const View = () => <a href={\`/search?q=\${location.search}\`}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={'/login?next=' + encodeURIComponent(location.hash)}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={location.href}>Share</a>;`,
    `${reactHeader}export const View = () => <a href={location.hash}>Anchor</a>;`,
    `${reactHeader}export const View = () => <a href={location.search || '?'}>Reload</a>;`,
    `${reactHeader}export const View = () => <a href={document.referrer || '/'}>Back</a>;`,
    `${reactHeader}export const View = ({ url }: { url: string }) => <a href={url}>Go</a>;`,
    `${reactHeader}declare const data: { url: string };\nexport const View = () => <a href={data.url}>Go</a>;`,
    `${reactHeader}declare function safeUrl(value: string | null): string;\nconst target = new URLSearchParams(location.search).get('next');\nexport const View = () => <a href={safeUrl(target)}>Go</a>;`,
    `${reactHeader}export const View = () => <img src={location.hash.slice(1)} />;`,
    `${reactHeader}export const View = () => <a title={location.hash}>Go</a>;`,
    `${reactHeader}declare function Custom(props: { href: string }): null;\nexport const View = () => <Custom href={location.hash} />;`,
    `${reactHeader}import { useRouter } from 'next/navigation';\nexport function View() { const router = useRouter(); return <a href={'/' + String(router)}>Go</a>; }`,
  ];
  for (const source of sources) assert.equal(urlFindingsOf(source).length, 0, source);
});

test('jsx-javascript-url: only React 18 and older or Preact render javascript: URLs as written', () => {
  const source = `${reactHeader}export const View = () => <a href={location.hash.slice(1)}>Go</a>;`;
  // null: no package.json at all.
  const projects: [object | null, number][] = [
    [{ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }, 0],
    [{ dependencies: { react: '^18.3.1' } }, 1],
    [{ devDependencies: { 'react-dom': '~17.0.2' }, dependencies: { react: '^19.0.0' } }, 1],
    [{ peerDependencies: { react: '^18.0.0 || ^19.0.0' } }, 1],
    [{ dependencies: { preact: '^10.19.0' } }, 1],
    [{ dependencies: { react: 'latest' } }, 0],
    [{ dependencies: { react: 'catalog:' } }, 0],
    [{ dependencies: { lodash: '^4.17.21' } }, 0],
    [null, 0],
  ];
  for (const [manifest, expected] of projects)
    assert.equal(urlFindingsOf(source, manifest).length, expected, JSON.stringify(manifest));
});

test("next-image-any-remote-host: hostname '**' in images.remotePatterns is reported", () => {
  const sources = [
    "export default { images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] } };",
    "const nextConfig = { reactStrictMode: true, images: { remotePatterns: [{ hostname: '**' }, { hostname: 'cdn.example.com' }] } };\nexport default nextConfig;",
  ];
  for (const source of sources) assert.equal(findingsOf('next-image-any-remote-host', source).length, 1, source);
});

test('next-image-any-remote-host: named hosts, subdomain patterns and other wildcards are clean', () => {
  const sources = [
    "export default { images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.example.com' }] } };",
    "export default { images: { remotePatterns: [{ hostname: '**.example.com' }] } };",
    "export default { images: { remotePatterns: [{ hostname: '*' }] } };",
    "export default { remotePatterns: [{ hostname: '**' }] };",
    "export const routes = [{ hostname: '**' }];",
  ];
  for (const source of sources) assert.equal(findingsOf('next-image-any-remote-host', source).length, 0, source);
});
