import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifierFor } from './compose.js';

describe('verifierFor', () => {
  it('uses the JWT secret when no JWKS URL is configured', async () => {
    const secret = 'test-secret-test-secret-test-secret!';
    const verifier = verifierFor({ supabaseJwksUrl: undefined, supabaseJwtSecret: secret });
    const token = await new SignJWT({ email: 'A@B.test' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('sub-1')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    expect(await verifier.verify(token)).toEqual({ subject: 'sub-1', email: 'a@b.test' });
  });

  it('builds a remote key set from the JWKS URL without contacting it', () => {
    const verifier = verifierFor({
      supabaseJwksUrl: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
      supabaseJwtSecret: undefined,
    });
    expect(verifier).toHaveProperty('verify');
  });
});
