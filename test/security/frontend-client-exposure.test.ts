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
    'const token = process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_TOKEN;',
    'const password = process.env.REACT_APP_ADMIN_PASSWORD;',
    'const secret = process.env.EXPO_PUBLIC_CLIENT_SECRET;',
    'const url = process.env.NUXT_PUBLIC_DATABASE_URL;',
    'const key = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;',
    'const key = import.meta.env.VITE_JWT_PRIVATE_KEY;',
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
    // Expo inlines only dot access.
    "process.env['EXPO_PUBLIC_CLIENT_SECRET'];",
    // Plain Vite exposes only `VITE_` on import.meta.env; `PUBLIC_` is Astro's prefix.
    'import.meta.env.PUBLIC_DB_PASSWORD;',
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

type ProjectScan = (ruleId: string, source: string, fileName?: string) => ReturnType<typeof analyzeFile>;

// Both rules read the project's package.json from disk, so these fixtures are real files. The outer
// manifest pins an unreadable React version, so no package.json above the temporary directory can
// change the answer.
function withDiskProject<Result>(
  manifest: object | null,
  callback: (scan: ProjectScan, writeManifest: (next: object) => void) => Result,
  outerManifest: object = { dependencies: { react: 'latest' } },
) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-frontend-'));
  const directory = path.join(outer, 'app');
  const writeFile = (name: string, content: string) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const writeManifest = (next: object) => writeFile('package.json', JSON.stringify(next));
  try {
    fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify(outerManifest));
    for (const [name, content] of Object.entries(urlStubs)) writeFile(name, content);
    if (manifest) writeManifest(manifest);
    const scan: ProjectScan = (ruleId, source, fileName = 'view.tsx') => {
      writeFile(fileName, source);
      const sourcePath = path.join(directory, fileName);
      const program = ts.createProgram([sourcePath], {
        ...compilerOptions,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: [],
        noEmit: true,
      });
      const sourceFile = program.getSourceFile(sourcePath);
      assert.ok(sourceFile);
      return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === ruleId);
    };
    return callback(scan, writeManifest);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}

function urlFindingsOf(source: string, manifest: object | null = react18) {
  return withDiskProject(manifest, (scan) => scan('jsx-javascript-url', source));
}

test('client-env-secret-exposed: import.meta.env.PUBLIC_ is exposed in Astro projects, VITE_ is not', () => {
  const astro = { dependencies: { astro: '^5.0.0' } };
  const scan = (source: string) =>
    withDiskProject(astro, (scanProject) => scanProject('client-env-secret-exposed', source, 'env.ts'));
  assert.equal(scan('export const key = import.meta.env.PUBLIC_API_SECRET;').length, 1);
  assert.equal(scan('export const key = import.meta.env.VITE_API_SECRET;').length, 0);
});

test('client-env-secret-exposed: a Vite app nested under an Astro workspace root keeps the Vite prefix', () => {
  const viteApp = { devDependencies: { vite: '^6.0.0' } };
  const astroRoot = { dependencies: { astro: '^5.0.0', react: 'latest' } };
  const scan = (source: string) =>
    withDiskProject(viteApp, (scanProject) => scanProject('client-env-secret-exposed', source, 'env.ts'), astroRoot);
  assert.equal(scan('export const key = import.meta.env.VITE_API_SECRET;').length, 1);
  assert.equal(scan('export const key = import.meta.env.PUBLIC_API_SECRET;').length, 0);
});

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
    `${reactHeader}export const View = () => <a href={'' + location.hash.slice(1)}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={\`  \${location.hash.slice(1)}\`}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={location.pathname.slice(1)}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={new URL(location.href).searchParams.get('next') ?? '/'}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={new URL(location.href).hash.slice(1)}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={String(location.hash.slice(1))}>Go</a>;`,
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
    `${reactHeader}export const View = () => <a href={decodeURIComponent(location.hash)}>Anchor</a>;`,
    `${reactHeader}export const View = () => <a href={String(location.hash)}>Anchor</a>;`,
    `${reactHeader}export const View = () => <a href={encodeURIComponent(location.hash.slice(1))}>Go</a>;`,
    `${reactHeader}export const View = () => <a href={' ' + location.href}>Share</a>;`,
    `${reactHeader}export const View = () => <a href={new URL(location.href).origin}>Home</a>;`,
    `${reactHeader}export const View = () => <a href={location.origin.slice(0)}>Home</a>;`,
    `${reactHeader}export const View = () => <div href={location.hash.slice(1)} />;`,
    `${reactHeader}export const View = () => <span action={location.hash.slice(1)} />;`,
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
    [{ optionalDependencies: { 'react-dom': '^18.2.0' } }, 1],
    [{ dependencies: { react: '<19' } }, 1],
    [{ dependencies: { react: '>= 18.2 <20' } }, 1],
    [{ dependencies: { react: '18 - 19' } }, 1],
    [{ dependencies: { react: '>=18.0.0 >=19.0.0' } }, 0],
    [{ dependencies: { react: '*' } }, 0],
    [{ dependencies: { react: 'latest' } }, 0],
    [{ dependencies: { react: 'catalog:' } }, 0],
    [{ dependencies: { lodash: '^4.17.21' } }, 0],
    [null, 0],
  ];
  for (const [manifest, expected] of projects)
    assert.equal(urlFindingsOf(source, manifest).length, expected, JSON.stringify(manifest));
});

test('jsx-javascript-url: a changed package.json takes effect without restarting the process', () => {
  const source = `${reactHeader}export const View = () => <a href={location.hash.slice(1)}>Go</a>;`;
  withDiskProject(react18, (scan, writeManifest) => {
    assert.equal(scan('jsx-javascript-url', source).length, 1);
    writeManifest({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } });
    assert.equal(scan('jsx-javascript-url', source).length, 0);
  });
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
