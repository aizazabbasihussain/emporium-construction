import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier, type AuthVerifier } from './jwt-verifier.service.js';

const secret = new TextEncoder().encode('verifier-test-secret-verifier-test-secret');
const now = new Date('2026-10-24T10:00:00Z');
const seconds = Math.floor(now.getTime() / 1000);

const hmacVerifier = (extra: { issuer?: string } = {}): AuthVerifier =>
  createJwtVerifier({ key: secret, audience: 'authenticated', now: () => now, ...extra });

const sign = (
  claims: Record<string, unknown> = { email: 'Person@Example.test' },
  options: { sub?: string | null; aud?: string; exp?: number; iss?: string; key?: Uint8Array } = {},
) => {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(options.aud ?? 'authenticated')
    .setIssuedAt(seconds)
    .setExpirationTime(options.exp ?? seconds + 3600);
  if (options.sub !== null) jwt.setSubject(options.sub ?? 'subject-1');
  if (options.iss !== undefined) jwt.setIssuer(options.iss);
  return jwt.sign(options.key ?? secret);
};

const rejects = async (verifier: AuthVerifier, token: string) => {
  await expect(verifier.verify(token)).rejects.toMatchObject({ kind: 'unauthorized' });
};

describe('AuthVerifier (T-1)', () => {
  it('accepts a valid token and lower-cases the email', async () => {
    expect(await hmacVerifier().verify(await sign())).toEqual({
      subject: 'subject-1',
      email: 'person@example.test',
    });
  });

  it('returns a null email when the token has none or a non-string one', async () => {
    expect((await hmacVerifier().verify(await sign({}))).email).toBeNull();
    expect((await hmacVerifier().verify(await sign({ email: 5 }))).email).toBeNull();
  });

  it('rejects an expired token', async () => {
    await rejects(hmacVerifier(), await sign({}, { exp: seconds - 10 }));
  });

  it('rejects a token for another audience', async () => {
    await rejects(hmacVerifier(), await sign({}, { aud: 'anon' }));
  });

  it('rejects a tampered token and one signed with another key', async () => {
    const token = await sign();
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');
    await rejects(hmacVerifier(), `${header}.${forged}.${signature}`);
    await rejects(
      hmacVerifier(),
      await sign({}, { key: new TextEncoder().encode('another-secret-another-secret-another') }),
    );
  });

  it('rejects garbage and a token without a subject', async () => {
    await rejects(hmacVerifier(), 'not-a-jwt');
    await rejects(hmacVerifier(), await sign({}, { sub: null }));
  });

  it('checks the issuer when one is configured', async () => {
    const verifier = hmacVerifier({ issuer: 'https://project.supabase.co/auth/v1' });
    await rejects(verifier, await sign({}, { iss: 'https://evil.example' }));
    expect(
      (await verifier.verify(await sign({}, { iss: 'https://project.supabase.co/auth/v1' })))
        .subject,
    ).toBe('subject-1');
  });
});

describe('AuthVerifier with a key set', () => {
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    const other = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    otherPrivateKey = other.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  const signEs = (key: CryptoKey, kid = 'k1') =>
    new SignJWT({ email: 'a@b.test' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('subject-2')
      .setAudience('authenticated')
      .setExpirationTime(seconds + 3600)
      .sign(key);

  it('verifies a token signed by a key in the set', async () => {
    const verifier = createJwtVerifier({ key: jwks, audience: 'authenticated', now: () => now });
    expect((await verifier.verify(await signEs(privateKey))).subject).toBe('subject-2');
  });

  it('rejects a token signed by an unknown key or carrying an HMAC signature', async () => {
    const verifier = createJwtVerifier({ key: jwks, audience: 'authenticated', now: () => now });
    await rejects(verifier, await signEs(otherPrivateKey));
    await rejects(verifier, await sign());
  });
});
