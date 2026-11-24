import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.cjs';

const ruleId = 'storage-object-public-acl';
const header = [
  'declare const s3: any;',
  'declare const bucket: any;',
  'declare const PutObjectCommand: any;',
  'declare const Upload: any;',
  'declare function other(options: object): void;',
].join('\n');

test('public ACLs on S3 and GCS uploads are reported', () => {
  const source = [
    header,
    "s3.upload({ Bucket: 'b', Key: 'docs/a.pdf', Body: '', ACL: 'public-read' });",
    "s3.putObject({ Bucket: 'b', Key: 'k', ACL: 'public-read-write' });",
    "new PutObjectCommand({ Bucket: 'b', Key: 'k', ACL: 'public-read' });",
    "new Upload({ client: s3, params: { Bucket: 'b', Key: 'k', ACL: 'public-read' } });",
    "bucket.file('x').save('data', { public: true });",
    "bucket.upload('p', { predefinedAcl: 'publicRead' });",
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 6);
});

test('public asset locations are contextual, public-read-write never is', () => {
  const source = [
    header,
    "s3.upload({ Bucket: 'b', Key: 'public/logo.png', ACL: 'public-read' });",
    "s3.upload({ Bucket: 'b', Key: 'public/logo.png', ACL: 'public-read-write' });",
  ].join('\n');
  const findings = findingsOf(ruleId, source);
  assert.equal(findings.length, 2);
  assert.ok(findings[0].contextualReason);
  assert.ok(!findings[1].contextualReason);
});

test('private ACLs and unrelated objects are quiet', () => {
  const source = [
    header,
    "s3.upload({ Bucket: 'b', Key: 'k', ACL: 'private' });",
    "s3.upload({ Bucket: 'b', Key: 'k' });",
    "bucket.file('x').save('data', { public: false });",
    "const rule = { ACL: 'public-read' };",
    "other({ ACL: 'public-read' });",
  ].join('\n');
  assert.equal(findingsOf(ruleId, source).length, 0);
});
