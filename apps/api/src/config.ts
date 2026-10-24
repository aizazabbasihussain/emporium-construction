import { fileStoreDrivers, type FileStoreDriver } from '@emporium/shared';
import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL'),
    SUPABASE_JWKS_URL: z.url().optional(),
    SUPABASE_JWT_SECRET: z.string().min(1).optional(),
    FILE_STORE_DRIVER: z.enum(fileStoreDrivers),
    ALLOW_GOVERNMENT_DATA: booleanFlag,
    CORS_ORIGINS: z.string().min(1),
    ADMIN_EMAIL: z.email().optional(),
  })
  .refine((env) => env.SUPABASE_JWKS_URL !== undefined || env.SUPABASE_JWT_SECRET !== undefined, {
    path: ['SUPABASE_JWKS_URL'],
    message: 'SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET is required',
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  supabaseJwksUrl: string | undefined;
  supabaseJwtSecret: string | undefined;
  fileStoreDriver: FileStoreDriver;
  allowGovernmentData: boolean;
  corsOrigins: string[];
  /** The first admin, created at startup if absent (spec P1-02 section 9). */
  adminEmail: string | undefined;
}

export class ConfigError extends Error {
  readonly variables: string[];

  constructor(issues: { variable: string; message: string }[]) {
    const variables = [...new Set(issues.map((i) => i.variable))];
    super(`Invalid configuration: ${issues.map((i) => `${i.variable} (${i.message})`).join('; ')}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

/** Read once at startup. Missing or invalid values throw a ConfigError naming each variable. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? 'env'),
        message: issue.message,
      })),
    );
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    supabaseJwksUrl: value.SUPABASE_JWKS_URL,
    supabaseJwtSecret: value.SUPABASE_JWT_SECRET,
    fileStoreDriver: value.FILE_STORE_DRIVER,
    allowGovernmentData: value.ALLOW_GOVERNMENT_DATA,
    corsOrigins: value.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    adminEmail: value.ADMIN_EMAIL?.toLowerCase(),
  };
}
