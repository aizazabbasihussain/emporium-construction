import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
  FILE_STORE_DRIVER: 'supabase',
  CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
};

function failureOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('config loader (T-2)', () => {
  it('accepts a valid environment and applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      databaseUrl: valid.DATABASE_URL,
      supabaseJwksUrl: valid.SUPABASE_JWKS_URL,
      supabaseJwtSecret: undefined,
      fileStoreDriver: 'supabase',
      allowGovernmentData: false,
      corsOrigins: ['http://localhost:5173', 'https://app.example.com'],
    });
  });

  it('reads the optional first-admin email in lower case and rejects a malformed one', () => {
    expect(loadConfig(valid).adminEmail).toBeUndefined();
    expect(loadConfig({ ...valid, ADMIN_EMAIL: 'Owner@Example.com' }).adminEmail).toBe(
      'owner@example.com',
    );
    expect(failureOf({ ...valid, ADMIN_EMAIL: 'not-an-email' }).variables).toEqual(['ADMIN_EMAIL']);
  });

  it('reads the optional file store driver settings (spec P1-04 BR-6)', () => {
    const config = loadConfig({
      ...valid,
      FILE_STORE_LOCAL_DIR: '/srv/files',
      FILE_URL_SECRET: 'a-long-enough-secret',
      PUBLIC_API_URL: 'https://api.example.test/',
      SUPABASE_URL: 'https://p.supabase.test',
      SUPABASE_SERVICE_KEY: 'service-key',
      SUPABASE_STORAGE_BUCKET: 'files',
    });
    expect(config).toMatchObject({
      fileStoreLocalDir: '/srv/files',
      fileUrlSecret: 'a-long-enough-secret',
      publicApiUrl: 'https://api.example.test',
      supabaseUrl: 'https://p.supabase.test',
      supabaseServiceKey: 'service-key',
      supabaseStorageBucket: 'files',
    });
    expect(loadConfig(valid).publicApiUrl).toBeUndefined();
    expect(failureOf({ ...valid, FILE_URL_SECRET: 'short' }).variables).toEqual([
      'FILE_URL_SECRET',
    ]);
  });

  it('defaults ALLOW_GOVERNMENT_DATA to false and accepts true only when set exactly', () => {
    expect(loadConfig(valid).allowGovernmentData).toBe(false);
    expect(loadConfig({ ...valid, ALLOW_GOVERNMENT_DATA: 'true' }).allowGovernmentData).toBe(true);
    expect(failureOf({ ...valid, ALLOW_GOVERNMENT_DATA: 'yes' }).variables).toEqual([
      'ALLOW_GOVERNMENT_DATA',
    ]);
  });

  it('accepts the JWT secret instead of the JWKS URL', () => {
    const { SUPABASE_JWKS_URL: _omitted, ...rest } = valid;
    const config = loadConfig({ ...rest, SUPABASE_JWT_SECRET: 'secret' });
    expect(config.supabaseJwtSecret).toBe('secret');
    expect(config.supabaseJwksUrl).toBeUndefined();
  });

  it.each(['DATABASE_URL', 'FILE_STORE_DRIVER', 'CORS_ORIGINS'])(
    'fails naming %s when it is missing',
    (name) => {
      const env: Record<string, string | undefined> = { ...valid };
      delete env[name];
      const error = failureOf(env);
      expect(error.variables).toEqual([name]);
      expect(error.message).toContain(name);
    },
  );

  it('fails naming SUPABASE_JWKS_URL when neither auth variable is set', () => {
    const { SUPABASE_JWKS_URL: _omitted, ...rest } = valid;
    expect(failureOf(rest).variables).toEqual(['SUPABASE_JWKS_URL']);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['SUPABASE_JWKS_URL', 'not a url'],
    ['FILE_STORE_DRIVER', 's3'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
  ])('fails naming %s when it is invalid', (name, value) => {
    expect(failureOf({ ...valid, [name]: value }).variables).toEqual([name]);
  });

  it('reports every problem at once', () => {
    expect(failureOf({}).variables).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'FILE_STORE_DRIVER', 'CORS_ORIGINS']),
    );
  });

  it('ignores empty entries in CORS_ORIGINS', () => {
    expect(
      loadConfig({ ...valid, CORS_ORIGINS: 'http://a.test,, ,http://b.test' }).corsOrigins,
    ).toEqual(['http://a.test', 'http://b.test']);
  });

  it('falls back to the variable name "env" for root-level issues', () => {
    expect(new ConfigError([{ variable: 'X', message: 'bad' }]).variables).toEqual(['X']);
  });
});
