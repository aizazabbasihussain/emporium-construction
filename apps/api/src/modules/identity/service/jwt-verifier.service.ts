import { UnauthorizedError } from '@emporium/domain';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface VerifiedToken {
  subject: string;
  email: string | null;
}

/** Verifies a bearer token; the only place that knows how tokens are signed (constitution 4). */
export interface AuthVerifier {
  /** Throws UnauthorizedError for an invalid, expired, tampered or wrong-audience token. */
  verify(token: string): Promise<VerifiedToken>;
}

export interface JwtVerifierOptions {
  /** HMAC secret bytes (legacy Supabase projects) or a key resolver such as a JWKS. */
  key: Uint8Array | JWTVerifyGetKey;
  audience: string;
  issuer?: string;
  now: () => Date;
}

const SECRET_ALGORITHMS = ['HS256'];
const JWKS_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'];

/** Supabase JWT implementation of AuthVerifier. */
export function createJwtVerifier(options: JwtVerifierOptions): AuthVerifier {
  return {
    async verify(token) {
      const verifyOptions = {
        audience: options.audience,
        currentDate: options.now(),
        ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
      };
      try {
        const { payload } =
          typeof options.key === 'function'
            ? await jwtVerify(token, options.key, { ...verifyOptions, algorithms: JWKS_ALGORITHMS })
            : await jwtVerify(token, options.key, {
                ...verifyOptions,
                algorithms: SECRET_ALGORITHMS,
              });
        if (typeof payload.sub !== 'string' || payload.sub === '') {
          throw new UnauthorizedError('invalid_token', 'Token has no subject');
        }
        return {
          subject: payload.sub,
          email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
        };
      } catch (error) {
        if (error instanceof UnauthorizedError) throw error;
        throw new UnauthorizedError('invalid_token', 'Invalid or expired token');
      }
    },
  };
}
