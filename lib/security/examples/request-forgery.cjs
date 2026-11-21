'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'open-redirect': [
    "const next = String(req.query.next ?? '/');\nconst target = next.startsWith('/') && !next.startsWith('//') ? next : '/';\nres.redirect(target);",
    'Redirect only to paths on this site, or compare `new URL(next).host` with an allowlist before redirecting.',
  ],
  'path-traversal': [
    'const fullPath = path.resolve(uploadRoot, req.params.name);\nif (!fullPath.startsWith(uploadRoot + path.sep)) throw new ForbiddenException();\nconst content = await readFile(fullPath);',
    'Resolve against the base directory and reject paths outside it. `res.sendFile(name, { root })` and `path.basename` are also safe.',
  ],
  'ssrf-request-url': [
    "const allowedHosts = new Set(['api.example.com']);\nconst target = new URL(input);\nif (!allowedHosts.has(target.hostname)) throw new BadRequestException();\nawait fetch(target);",
    'Allow known hosts only, or keep a fixed origin and let the caller choose only the path: `fetch(`${API_ORIGIN}/items/${id}`)`.',
  ],
  'upload-client-filename': [
    'const storage = diskStorage({\n  destination: uploadDirectory,\n  filename: (req, file, cb) => cb(null, randomUUID() + extensionFor(file.mimetype)),\n});',
    'Store uploads under a generated name and an extension from an allowlist; save `file.originalname` in the database if users need it.',
  ],
  'zip-slip-extraction': [
    'const target = path.resolve(destination, entry.entryName);\nif (!target.startsWith(destination + path.sep)) continue;\nawait writeFile(target, entry.getData());',
    'Resolve each entry against the destination and skip entries that leave it, or extract with a library that checks this.',
  ],
};
