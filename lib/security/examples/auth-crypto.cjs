'use strict';

// Rule id -> [code, note]: a fix example of at most six lines that parses as JavaScript.
module.exports = {
  'bcrypt-low-cost': [
    'const hash = await bcrypt.hash(password, 12);',
    'Use a cost of 10 or higher; 12 is a common choice. Measure the hashing time on your hardware and raise the cost while a login stays fast enough.',
  ],
  'hardcoded-secret': [
    "const secret = process.env.JWT_SECRET;\nif (!secret) throw new Error('JWT_SECRET is not set');\nconst token = jwt.sign(payload, secret, { expiresIn: '15m' });",
    'Read the credential from the environment or a secret manager, and rotate the value that was committed.',
  ],
  'insecure-cipher': [
    "const iv = crypto.randomBytes(12);\nconst cipher = crypto.createCipheriv('aes-256-gcm', key, iv);\nconst encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);\nconst tag = cipher.getAuthTag();",
    'Use an authenticated mode with a fresh random IV for every message and store the IV and auth tag with the ciphertext.',
  ],
  'insecure-random-for-secret': [
    "import { randomBytes, randomInt } from 'node:crypto';\nconst resetToken = randomBytes(32).toString('hex');\nconst otp = randomInt(100000, 1000000);",
    'Use crypto.randomBytes for tokens, crypto.randomInt for numeric codes and crypto.randomUUID for identifiers.',
  ],
  'jwt-decode-for-auth': [
    "const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] });\nrequest.user = { id: claims.sub };",
    'Verify the signature with the expected algorithms before reading any claim, then use the verified payload.',
  ],
  'jwt-none-algorithm': [
    "jwt.verify(token, publicKey, { algorithms: ['RS256'] });",
    'List only the algorithms you sign with; never include none.',
  ],
  'jwt-sign-without-expiry': [
    "const accessToken = jwt.sign({ sub: user.id }, secret, { expiresIn: '15m' });",
    'Give access tokens a short lifetime and issue refresh tokens for longer sessions.',
  ],
  'jwt-verify-without-algorithms': [
    "const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] });",
    'Pin the algorithms you sign with, so the token header cannot choose how it is checked.',
  ],
  'secret-compared-non-constant-time': [
    'const received = Buffer.from(signature);\nconst expected = Buffer.from(computedSignature);\nconst valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);',
    'Compare secrets with crypto.timingSafeEqual on buffers of equal length.',
  ],
  'tls-verification-disabled': [
    "const client = new Client({ ssl: { ca: fs.readFileSync('rds-ca.pem', 'utf8') } });",
    'Keep certificate verification on and trust the private CA with the ca option instead of switching verification off.',
  ],
  'weak-password-hash': [
    'const passwordHash = await bcrypt.hash(password, 12);\nconst matches = await bcrypt.compare(attempt, passwordHash);',
    'Hash passwords with bcrypt, argon2 or crypto.scrypt. Existing hashes need a migration: re-hash each password at its next successful login.',
  ],
};
