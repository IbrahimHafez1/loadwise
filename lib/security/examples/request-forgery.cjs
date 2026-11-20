'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'open-redirect': [
    "const next = String(req.query.next ?? '/');\nconst target = next.startsWith('/') && !next.startsWith('//') ? next : '/';\nres.redirect(target);",
    'Redirect only to paths on this site, or compare `new URL(next).host` with an allowlist before redirecting.',
  ],
  'ssrf-request-url': [
    "const allowedHosts = new Set(['api.example.com']);\nconst target = new URL(input);\nif (!allowedHosts.has(target.hostname)) throw new BadRequestException();\nawait fetch(target);",
    'Allow known hosts only, or keep a fixed origin and let the caller choose only the path: `fetch(`${API_ORIGIN}/items/${id}`)`.',
  ],
};
