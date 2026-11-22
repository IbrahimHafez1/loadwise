'use strict';

// storage-object-public-acl: an S3 or Google Cloud Storage upload makes the object readable by everyone.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { unwrap, nameText, methodName } = require('./literals.cjs');

const ruleId = 'storage-object-public-acl';
const message =
  'This upload makes the stored object publicly readable. Keep objects private and hand out short-lived presigned URLs (for example with getSignedUrl).';
const publicAssetsReason =
  'The key or bucket name suggests public assets, so a public object may be intended. Confirm nothing private is stored here.';
const uploadCallNames = new Set([
  'upload',
  'putObject',
  'createMultipartUpload',
  'copyObject',
  'copy',
  'save',
  'createWriteStream',
  'PutObjectCommand',
  'CreateMultipartUploadCommand',
  'CopyObjectCommand',
  'Upload',
]);
const publicS3Acls = new Set(['public-read', 'public-read-write', 'PublicRead', 'PublicReadWrite']);
const readWriteAcls = new Set(['public-read-write', 'PublicReadWrite', 'publicReadWrite']);
const publicGcsAcls = new Set(['publicRead', 'publicReadWrite']);
// Keys, bucket names and destinations that are meant to be served openly.
const publicAssetsPattern = /(?:^|[^a-z])(?:public|assets?|static|avatars?|thumbnails?)(?:[^a-z]|$)/i;
const locationProperties = new Set(['Key', 'key', 'Bucket', 'bucket', 'destination']);

function calledName(call) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isCallExpression(call) ? methodName(call) : undefined;
}

// The upload call that receives this property through nested option objects (`Upload({ params: { ACL } })`).
function enclosingUploadCall(property) {
  let node = property.parent;
  while (node && (ts.isObjectLiteralExpression(node) || ts.isPropertyAssignment(node))) node = node.parent;
  if (!node || !(ts.isCallExpression(node) || ts.isNewExpression(node))) return;
  return uploadCallNames.has(calledName(node)) ? node : undefined;
}

function aclName(value) {
  if (ts.isStringLiteralLike(value)) return value.text;
  return ts.isPropertyAccessExpression(value) ? value.name.text : undefined;
}

function isPublicAcl(property) {
  const value = unwrap(property.initializer);
  const propertyName = nameText(property.name);
  if (propertyName === 'ACL') return publicS3Acls.has(aclName(value));
  if (propertyName === 'predefinedAcl') return publicGcsAcls.has(aclName(value));
  return propertyName === 'public' && value.kind === ts.SyntaxKind.TrueKeyword;
}

// Text naming where the object goes: the sibling Key/Bucket/destination options and the call's receiver.
function locationText(property, call) {
  const parts = [ts.isCallExpression(call) ? call.expression.getText() : ''];
  for (let node = property.parent; node && node !== call; node = node.parent) {
    if (!ts.isObjectLiteralExpression(node)) continue;
    for (const sibling of node.properties)
      if (ts.isPropertyAssignment(sibling) && locationProperties.has(nameText(sibling.name)))
        parts.push(sibling.initializer.getText());
  }
  return parts.join(' ');
}

function checkProperty(property, context) {
  if (!isPublicAcl(property)) return;
  const call = enclosingUploadCall(property);
  if (!call) return;
  const isReadWrite = readWriteAcls.has(aclName(unwrap(property.initializer)));
  const looksPublic = !isReadWrite && publicAssetsPattern.test(locationText(property, call));
  context.report(property, ruleId, message, looksPublic ? publicAssetsReason : undefined);
}

module.exports = { checkProperty };
