// Rule id -> [code, note] for the project-file rules. These show env, Dockerfile and compose text,
// not TypeScript.
import type { RuleExamples } from '../types/rule-example.js';

const examples: RuleExamples = {
  'committed-secret': [
    '# .gitignore\n.env\n# keep .env.example with placeholders only',
    'Remove the file from git, rotate the exposed credential and load the real value from the environment or a secret manager.',
  ],
  'compose-hardcoded-secret': [
    'environment:\n  - JWT_SECRET=${JWT_SECRET}',
    'Substitute the value from the shell or an env file that is not committed, or use a compose secret.',
  ],
  'dockerfile-add-remote-url': [
    'RUN curl -fsSL -o app.tgz https://example.com/app.tgz \\\n && echo "<sha256>  app.tgz" | sha256sum -c -',
    'Download with curl and verify a checksum, or COPY a file you vendored.',
  ],
  'dockerfile-runs-as-root': [
    'RUN adduser --system app\nUSER app',
    'Create or reuse a non-root account in the final stage and switch to it with USER.',
  ],
  'dockerfile-secret-in-build': [
    'RUN --mount=type=secret,id=npm_token \\\n  NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci',
    'Use a build secret mount instead of ARG, ENV or COPY, so the value never reaches an image layer.',
  ],
  'dockerfile-unpinned-base-image': [
    'FROM node:22.11-alpine',
    'Pin a version tag, or an image digest for fully reproducible builds.',
  ],
};

export default examples;
