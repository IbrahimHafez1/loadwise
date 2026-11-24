// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types';
// see bindings.cjs).
export default {
  'bcrypt-low-cost': { needs: 'import' },
  'hardcoded-secret': { needs: 'syntax' },
  'insecure-cipher': { needs: 'import' },
  'insecure-random-for-secret': { needs: 'syntax' },
  'jwt-decode-for-auth': { needs: 'import' },
  'jwt-none-algorithm': { needs: 'syntax' },
  'jwt-sign-without-expiry': { needs: 'import' },
  'jwt-verify-without-algorithms': { needs: 'import' },
  'secret-compared-non-constant-time': { needs: 'import' },
  'tls-verification-disabled': { needs: 'syntax' },
  'weak-password-hash': { needs: 'import' },
  'plaintext-password-storage': { needs: 'syntax' },
  'auth-route-without-rate-limit': { needs: 'syntax' },
};
