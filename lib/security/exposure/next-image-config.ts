// next-image-any-remote-host: `images.remotePatterns` in a Next.js config lets `hostname: '**'`
// match every host, so `/_next/image?url=...` fetches and serves any URL an attacker names: an open
// proxy that bills the app for the bandwidth and reaches hosts only the server can see.
import { ts } from '../../performance/compiler.js';
import { nameText, unwrap } from './literals.js';
import type { Node, PropertyAssignment } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'next-image-any-remote-host';
const message =
  "`hostname: '**'` in `images.remotePatterns` lets the Next.js image optimizer fetch and serve images from any host, so anyone can use `/_next/image` as an open proxy to arbitrary or internal URLs. List the exact hosts (or a `**.your-cdn.com` subdomain pattern) instead.";
// `*` matches one host label; `**` matches every host.
const anyHost = '**';

function propertyName(node: Node | undefined) {
  return node && ts.isPropertyAssignment(node) ? nameText(node.name) : undefined;
}

// hostname -> { } -> [ ] -> remotePatterns: -> { } -> images:
function isRemotePatternHost(property: PropertyAssignment) {
  const pattern = property.parent;
  const patterns = pattern.parent;
  if (!ts.isArrayLiteralExpression(patterns)) return false;
  const remotePatterns = patterns.parent;
  if (propertyName(remotePatterns) !== 'remotePatterns') return false;
  return propertyName(remotePatterns.parent.parent) === 'images';
}

function checkProperty(property: PropertyAssignment, context: SecurityRuleContext) {
  if (nameText(property.name) !== 'hostname') return;
  const value = unwrap(property.initializer);
  if (!ts.isStringLiteralLike(value) || value.text !== anyHost) return;
  if (isRemotePatternHost(property)) context.report(property, ruleId, message);
}

export { checkProperty };
