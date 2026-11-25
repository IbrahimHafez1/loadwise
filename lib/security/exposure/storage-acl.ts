// storage-object-public-acl: an S3 or Google Cloud Storage upload makes the object readable by
// everyone.
import { ts } from '../../performance/compiler.js';
import { unwrap, nameText, methodName } from './literals.js';
import type { CallExpression, Expression, NewExpression, Node, PropertyAssignment } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

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

function calledName(call: CallExpression | NewExpression) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isCallExpression(call) ? methodName(call) : undefined;
}

// The upload call that receives this property through nested option objects (`Upload({ params: {
// ACL } })`).
function enclosingUploadCall(property: PropertyAssignment): CallExpression | NewExpression | undefined {
  let node: Node | undefined = property.parent;
  while (node && (ts.isObjectLiteralExpression(node) || ts.isPropertyAssignment(node))) node = node.parent;
  if (!node || !(ts.isCallExpression(node) || ts.isNewExpression(node))) return;
  const name = calledName(node);
  return name !== undefined && uploadCallNames.has(name) ? node : undefined;
}

function aclName(value: Expression) {
  if (ts.isStringLiteralLike(value)) return value.text;
  return ts.isPropertyAccessExpression(value) ? value.name.text : undefined;
}

function isPublicAcl(property: PropertyAssignment) {
  const value = unwrap(property.initializer);
  const propertyName = nameText(property.name);
  const acl = aclName(value);
  if (propertyName === 'ACL') return acl !== undefined && publicS3Acls.has(acl);
  if (propertyName === 'predefinedAcl') return acl !== undefined && publicGcsAcls.has(acl);
  return propertyName === 'public' && value.kind === ts.SyntaxKind.TrueKeyword;
}

// Text naming where the object goes: the sibling Key/Bucket/destination options and the call's
// receiver.
function locationText(property: PropertyAssignment, call: CallExpression | NewExpression) {
  const parts = [ts.isCallExpression(call) ? call.expression.getText() : ''];
  for (let node: Node | undefined = property.parent; node && node !== call; node = node.parent) {
    if (!ts.isObjectLiteralExpression(node)) continue;
    for (const sibling of node.properties) {
      if (!ts.isPropertyAssignment(sibling)) continue;
      const name = nameText(sibling.name);
      if (name !== undefined && locationProperties.has(name)) parts.push(sibling.initializer.getText());
    }
  }
  return parts.join(' ');
}

function checkProperty(property: PropertyAssignment, context: SecurityRuleContext) {
  if (!isPublicAcl(property)) return;
  const call = enclosingUploadCall(property);
  if (!call) return;
  const acl = aclName(unwrap(property.initializer));
  const isReadWrite = acl !== undefined && readWriteAcls.has(acl);
  const looksPublic = !isReadWrite && publicAssetsPattern.test(locationText(property, call));
  context.report(property, ruleId, message, looksPublic ? publicAssetsReason : undefined);
}

export { checkProperty };
