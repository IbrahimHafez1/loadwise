'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkDockerfile, isDockerfile } = require('../../lib/security/files/dockerfile.cjs');

const realPassword = 'k3Jf9xQ2mZ7vB5nL';

function rules(text, file = 'Dockerfile') {
  return checkDockerfile(file, text).map(({ ruleId, line }) => `${ruleId}:${line}`);
}

test('Dockerfile names are recognised', () => {
  for (const name of ['Dockerfile', 'prod.Dockerfile', 'Dockerfile.dev', 'api/Dockerfile'])
    assert.ok(isDockerfile(name));
  assert.ok(!isDockerfile('README.md'));
});

test('a final stage without USER runs as root; a later non-root USER is fine', () => {
  assert.deepEqual(rules('FROM node:22\nCMD ["node"]'), ['dockerfile-runs-as-root:1']);
  assert.deepEqual(rules('FROM node:22\nUSER node\nCMD ["node"]'), []);
  assert.deepEqual(rules('FROM node:22\nUSER app:app\nUSER 1000'), []);
});

test('the last USER root is reported on its line', () => {
  assert.deepEqual(rules('FROM node:22\nUSER app\nRUN x\nUSER root'), ['dockerfile-runs-as-root:4']);
  assert.deepEqual(rules('FROM node:22\nUSER 0:0'), ['dockerfile-runs-as-root:2']);
});

test('builder stages may run as root; the final stage inherits a user from a stage it extends', () => {
  const multi = 'FROM node:22 AS build\nRUN npm ci\nFROM node:22-alpine\nUSER node\nCOPY --from=build /a /a';
  assert.deepEqual(rules(multi), []);
  const noUser = 'FROM node:22 AS build\nRUN npm ci\nFROM node:22-alpine\nCOPY --from=build /a /a';
  assert.deepEqual(rules(noUser), ['dockerfile-runs-as-root:3']);
  assert.deepEqual(rules('FROM node:22 AS base\nUSER app\nFROM base\nCMD x'), []);
  assert.deepEqual(rules('FROM node:22 AS base\nFROM base\nCMD x'), ['dockerfile-runs-as-root:2']);
});

test('scratch and non-root base images are not reported as root', () => {
  assert.deepEqual(rules('FROM scratch\nCOPY app /app'), []);
  assert.deepEqual(rules('FROM nginxinc/nginx-unprivileged:1.27\nCOPY a /a'), []);
});

test('base images without a tag or with :latest are reported; tags, digests and stage names are not', () => {
  assert.deepEqual(rules('FROM node\nUSER node'), ['dockerfile-unpinned-base-image:1']);
  assert.deepEqual(rules('FROM node:latest\nUSER node'), ['dockerfile-unpinned-base-image:1']);
  assert.deepEqual(rules('FROM registry.local:5000/team/app\nUSER node'), ['dockerfile-unpinned-base-image:1']);
  assert.deepEqual(rules('FROM node:22.11-alpine\nUSER node'), []);
  assert.deepEqual(rules('FROM node@sha256:0123456789abcdef\nUSER node'), []);
  assert.deepEqual(rules('FROM node:22 AS build\nFROM build\nUSER node'), []);
  assert.deepEqual(rules('ARG BASE=node:22\nFROM ${BASE}\nUSER node'), []);
  assert.deepEqual(rules('FROM --platform=linux/amd64 node:22\nUSER node'), []);
});

test('ARG and ENV with a literal secret default are reported without the value', () => {
  const text = [
    'FROM node:22',
    `ARG NPM_TOKEN=${realPassword}`,
    `ENV JWT_SECRET=${realPassword} NODE_ENV=production`,
    `ENV DB_PASSWORD ${realPassword}`,
    'ARG API_KEY',
    'ARG SECRET_KEY=changeme',
    'ENV TOKEN_TTL=86400',
    'USER node',
  ].join('\n');
  const findings = checkDockerfile('Dockerfile', text);
  assert.deepEqual(
    findings.map(({ ruleId, line }) => `${ruleId}:${line}`),
    ['dockerfile-secret-in-build:2', 'dockerfile-secret-in-build:3', 'dockerfile-secret-in-build:4'],
  );
  assert.ok(!JSON.stringify(findings).includes(realPassword));
});

test('COPY of an env file or private key is reported; templates and stage copies are not', () => {
  const text = [
    'FROM node:22',
    'COPY .env /app/.env',
    'COPY --chown=node id_rsa /root/.ssh/',
    'COPY certs/server-key.pem /etc/ssl/',
    'COPY .env.example /app/',
    'COPY ca.pem /etc/ssl/',
    'COPY --from=build /app/.env /app/',
    'USER node',
  ].join('\n');
  assert.deepEqual(rules(text), [
    'dockerfile-secret-in-build:2',
    'dockerfile-secret-in-build:3',
    'dockerfile-secret-in-build:4',
  ]);
});

test('ADD of a remote URL is reported unless it has a checksum', () => {
  assert.deepEqual(rules('FROM node:22\nUSER node\nADD https://example.com/a.tgz /a/'), [
    'dockerfile-add-remote-url:3',
  ]);
  assert.deepEqual(rules('FROM node:22\nUSER node\nADD --checksum=sha256:abc https://example.com/a.tgz /a/'), []);
  assert.deepEqual(rules('FROM node:22\nUSER node\nADD a.tgz /a/'), []);
});

test('continuation lines form one instruction and comments are ignored', () => {
  const text =
    'FROM node:22\n# ENV JWT_SECRET=abcdefghijklmnop\nENV A=1 \\\n  JWT_SECRET=' + realPassword + '\nUSER node';
  assert.deepEqual(rules(text), ['dockerfile-secret-in-build:3']);
});

test('development and test Dockerfiles are contextual', () => {
  const [finding] = checkDockerfile('Dockerfile.dev', 'FROM node:22');
  assert.equal(finding.contextualReason, 'Development or test image.');
  assert.equal(checkDockerfile('Dockerfile', 'FROM node:22')[0].contextualReason, undefined);
});
