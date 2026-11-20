'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'ssrf-request-url': [
    "const allowedHosts = new Set(['api.example.com']);\nconst target = new URL(input);\nif (!allowedHosts.has(target.hostname)) throw new BadRequestException();\nawait fetch(target);",
    'Allow known hosts only, or keep a fixed origin and let the caller choose only the path: `fetch(`${API_ORIGIN}/items/${id}`)`.',
  ],
};
