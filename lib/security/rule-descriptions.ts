// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const descriptionByRule = {
  'angular-bypass-security-trust':
    "DomSanitizer.bypassSecurityTrust* is called on a dynamic value, which turns off Angular's built-in sanitization.",
  'auth-route-without-rate-limit': 'A login, signup or password-reset route has no rate limiter.',
  'bcrypt-low-cost': 'A bcrypt password hash uses a work factor below the recommended minimum.',
  'client-env-secret-exposed':
    'A secret-named env variable is read under a browser prefix (NEXT_PUBLIC_, VITE_, REACT_APP_...), so the build ships it to every visitor.',
  'code-injection': 'Request-controlled input becomes source code evaluated by the application.',
  'command-injection': 'Request-controlled input reaches a shell command string.',
  'committed-secret': 'A tracked file contains a value that appears to be a credential.',
  'compose-hardcoded-secret': 'A Docker Compose service supplies a secret as a literal environment value.',
  'cookie-missing-security-flags': 'A sensitive cookie is set without the expected security attributes.',
  'cors-credentials-any-origin': 'A credentialed CORS response allows arbitrary origins.',
  'cors-origin-regex-unanchored': 'A CORS origin regex also accepts look-alike hosts.',
  'csharp-ef-from-sql-raw':
    'FromSqlRaw or ExecuteSqlRaw receives a concatenated or interpolated string, risking SQL injection.',
  'csharp-process-start':
    'Process.Start launches an external process and risks command injection with untrusted arguments.',
  'database-error-in-response': 'An HTTP response includes a raw database error message.',
  'dependency-known-vulnerability': 'A resolved dependency version is listed in a published vulnerability advisory.',
  'dockerfile-add-remote-url': 'A Dockerfile ADD instruction retrieves a resource from a remote URL.',
  'dockerfile-runs-as-root': 'The final image selects root or inherits an unverified base-image user.',
  'dockerfile-secret-in-build': 'A Dockerfile exposes a secret through a build argument or environment variable.',
  'dockerfile-unpinned-base-image': 'A Dockerfile uses a base image reference that can change between builds.',
  'dom-xss-sink':
    'Untrusted or dynamic HTML reaches innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment (DOM XSS).',
  'drizzle-scope-unverified': 'A Drizzle operation lacks the row scope required by the declared policy.',
  'drizzle-sql-raw-dynamic': 'A dynamic SQL fragment reaches Drizzle without parameter binding.',
  'error-stack-in-response': 'An HTTP response includes an internal error stack.',
  'express-cookie-auth-missing-csrf':
    'Cookie-based session or auth is paired with state-changing routes without CSRF protection or `sameSite: "strict"`.',
  'express-missing-helmet':
    'The Express or NestJS server starts without helmet security headers middleware (contextual: a proxy may set them).',
  'frontend-storage-secret-token':
    'A token, JWT, password or API key is stored in localStorage or sessionStorage, readable by any script on the page.',
  'go-exec-command-shell': 'exec.Command invokes a shell, which risks command injection.',
  'go-sql-sprintf-injection': 'SQL text formatted with fmt.Sprintf risks SQL injection.',
  'graphql-batching-unbounded':
    'GraphQL query batching is enabled without a batch size, query depth, or cost/complexity limit.',
  'graphql-introspection-enabled': 'A GraphQL server explicitly enables schema introspection.',
  'graphql-query-depth-unbounded': 'A GraphQL server accepts queries of any depth.',
  'hardcoded-secret': 'The source supplies a literal credential or cryptographic secret.',
  'insecure-cipher': 'A cryptographic operation selects an insecure cipher or mode.',
  'insecure-random-for-secret': 'A sensitive token or secret uses a non-cryptographic random source.',
  'java-runtime-exec':
    'Runtime.getRuntime().exec runs an OS command and risks command injection with untrusted arguments.',
  'java-sql-string-concat': 'A SQL query built by string concatenation risks SQL injection.',
  'jsx-javascript-url':
    'In React 18 and older or Preact, a URL search parameter or location hash starts a JSX href, action or iframe src (javascript: XSS).',
  'jwt-decode-for-auth': 'Authentication uses decoded JWT claims without verifying the token signature.',
  'jwt-none-algorithm': 'JWT signing or verification allows an unsigned token.',
  'jwt-sign-without-expiry': 'A signed JWT has no explicit expiration.',
  'jwt-verify-without-algorithms': 'JWT verification does not restrict the accepted signing algorithms.',
  'jwt-weak-secret-literal':
    'JWT signing or verification uses a short (< 32 chars) or weak literal secret susceptible to brute-force forgery.',
  'knex-raw-dynamic-text': 'A dynamic SQL fragment reaches Knex without parameter binding.',
  'mass-assignment': 'An unfiltered request body reaches a persistence operation.',
  'mysql-dynamic-query-text': 'Dynamic SQL text reaches a MySQL client without parameter binding.',
  'nest-validation-without-whitelist': 'A NestJS ValidationPipe permits properties outside the validated DTO.',
  'next-image-any-remote-host':
    "A Next.js images.remotePatterns entry sets hostname '**', so the image optimizer fetches and serves any host (open proxy).",
  'nosql-operator-injection': 'Request data can introduce query operators into a NoSQL filter.',
  'open-redirect': 'An HTTP redirect destination is controlled by request data.',
  'password-hash-in-response': 'A response returns a user record that still holds its password hash.',
  'path-traversal': 'Request data controls a filesystem path without a recognized containment check.',
  'pg-dynamic-query-text': 'Dynamic SQL text reaches the PostgreSQL client without parameter binding.',
  'plaintext-password-storage': 'A password is stored or written without being hashed.',
  'postmessage-missing-origin-check':
    "postMessage targets '*', or a window message listener reads event.data without checking origin or source.",
  'prisma-raw-unsafe-dynamic': 'Dynamic SQL text reaches an unsafe Prisma raw-query method.',
  'prisma-scope-unverified': 'A Prisma operation lacks the row scope required by the declared policy.',
  'prototype-pollution': 'Request data can supply keys to a write or merge that can modify an object prototype.',
  'python-insecure-deserialization': 'pickle or marshal deserialization of untrusted data can execute arbitrary code.',
  'python-subprocess-shell-true':
    'subprocess with shell=True or os.system passes input through a shell, risking command injection.',
  'python-unsafe-yaml-load': 'yaml.load without SafeLoader can construct arbitrary Python objects.',
  'react-dangerously-set-inner-html': 'dangerouslySetInnerHTML receives HTML that is not a constant or sanitized.',
  'reflected-xss-response': 'An HTML response reflects request data without recognized escaping.',
  'regex-catastrophic-backtracking':
    'A regular expression that can backtrack exponentially or in polynomial time runs on request input.',
  'regex-from-input': 'Request input supplies a regular expression pattern without recognized escaping.',
  'rust-command-shell': 'Command::new("sh") or Command::new("bash") spawns a shell and risks command injection.',
  'rust-unsafe-raw-pointer-deref':
    'A raw pointer dereference in an unsafe block bypasses Rust memory safety guarantees.',
  'secret-compared-non-constant-time':
    'A secret is compared with an operation that can vary in timing with its contents.',
  'secret-in-log': 'A log statement can expose a credential, token, or other secret.',
  'secret-in-url-query': 'A password, token or API key is passed in a URL query string.',
  'sequelize-dynamic-query-text': 'Dynamic SQL text reaches Sequelize without parameter binding.',
  'server-action-missing-auth':
    'An exported Next.js Server Action performs work without verifying authentication or session state.',
  'ssrf-redirect-bypass':
    'An outbound HTTP request with a dynamic URL does not disable redirects, allowing SSRF allowlist bypasses.',
  'ssrf-request-url': 'Request data controls the destination of a server-side network request.',
  'storage-object-public-acl': 'A storage upload makes the object publicly readable.',
  'template-autoescape-disabled': 'A template engine is configured to render values without HTML escaping.',
  'template-injection': 'Request data is interpreted as template source rather than a template value.',
  'tls-verification-disabled': 'A TLS client skips certificate or server hostname verification.',
  'typeorm-dynamic-query-text': 'A dynamic SQL fragment reaches TypeORM without parameter binding.',
  'upload-client-filename': 'A file upload is stored under the original name supplied by the client.',
  'vm-sandbox-escape':
    'Node `vm` or `vm2` executes dynamic code or an untrusted context, risking sandbox escape and host RCE.',
  'vue-v-html-unsanitized': 'A Vue render function binds unsanitized dynamic HTML to innerHTML.',
  'weak-password-hash': 'A password is hashed with an algorithm unsuitable for password storage.',
  'xml-external-entities': 'An XML parser allows processing of external entities.',
  'zip-slip-extraction': 'An archive entry controls an extraction path without a recognized containment check.',
};

export { descriptionByRule };
