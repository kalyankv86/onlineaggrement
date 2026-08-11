/**
 * Typed configuration. Every value comes from the environment (SDD §13: secrets
 * outside source code); nothing here has a production-safe default that could be
 * shipped by accident — `assertProductionConfig` fails startup instead.
 */
export interface AppConfig {
  env: string;
  port: number;
  apiBaseUrl: string;
  publicVerifyBaseUrl: string;
  database: { url: string };
  redis: { url: string };
  /**
   * Documents live on a GTIDS-owned NAS export mounted on the application
   * server. There is no object-store service and no cloud provider — `fsRoot` is
   * the mountpoint.
   */
  storage: { fsRoot: string; signedUrlTtlSeconds: number; requireMountpoint: boolean };
  auth: {
    jwtSecret: string;
    accessTtl: string;
    absoluteTtl: string;
    partyAccessTokenTtlHours: number;
    bcryptRounds: number;
  };
  esign: {
    provider: string;
    callbackSecret: string;
    callbackToleranceSeconds: number;
    transactionTtlMinutes: number;
  };
  pdf: { renderer: 'pdflib' | 'playwright'; signatureReservedBytes: number };
  mail: {
    transport: 'json' | 'smtp';
    host?: string;
    port: number;
    user?: string;
    password?: string;
    from: string;
  };
  workflow: { defaultSlaDays: number; defaultReminderDays: number[]; maxSignatureAttempts: number };
  rateLimit: { verifyPerMinute: number };
}

const str = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required configuration: ${key}`);
  return v;
};
const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : Number(v);
};

export const configuration = (): AppConfig => ({
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  apiBaseUrl: str('API_BASE_URL', 'http://localhost:3000'),
  publicVerifyBaseUrl: str('PUBLIC_VERIFY_BASE_URL', 'http://localhost:3000/api/v1/verify'),
  database: { url: str('DATABASE_URL', 'postgresql://localhost:5432/gtids_agreements') },
  redis: { url: str('REDIS_URL', 'redis://localhost:6379') },
  storage: {
    fsRoot: str('STORAGE_FS_ROOT', './storage'),
    signedUrlTtlSeconds: num('STORAGE_SIGNED_URL_TTL_SECONDS', 300),
    // On by default in production. Turning it off removes the protection against
    // a marker file created by hand on local disk, so it is deliberately explicit.
    requireMountpoint: str('STORAGE_REQUIRE_MOUNTPOINT', 'true') !== 'false',
  },
  auth: {
    jwtSecret: str('JWT_SECRET', 'dev-only-secret'),
    accessTtl: str('JWT_ACCESS_TTL', '30m'),
    absoluteTtl: str('JWT_ABSOLUTE_TTL', '12h'),
    partyAccessTokenTtlHours: num('PARTY_ACCESS_TOKEN_TTL_HOURS', 72),
    bcryptRounds: num('BCRYPT_ROUNDS', 12),
  },
  esign: {
    provider: str('ESIGN_PROVIDER', 'mock'),
    callbackSecret: str('ESIGN_CALLBACK_SECRET', 'dev-only-secret'),
    callbackToleranceSeconds: num('ESIGN_CALLBACK_TOLERANCE_SECONDS', 300),
    transactionTtlMinutes: num('ESIGN_TRANSACTION_TTL_MINUTES', 30),
  },
  pdf: {
    renderer: str('PDF_RENDERER', 'pdflib') as 'pdflib' | 'playwright',
    signatureReservedBytes: num('PDF_SIGNATURE_RESERVED_BYTES', 8192),
  },
  mail: {
    transport: str('SMTP_TRANSPORT', 'json') as 'json' | 'smtp',
    host: process.env.SMTP_HOST || undefined,
    port: num('SMTP_PORT', 587),
    user: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASSWORD || undefined,
    from: str('MAIL_FROM', 'GTIDS Agreements <agreements@gtids.example>'),
  },
  workflow: {
    defaultSlaDays: num('DEFAULT_STAGE_SLA_DAYS', 14),
    defaultReminderDays: str('DEFAULT_REMINDER_DAYS', '3,7,12').split(',').map(Number),
    maxSignatureAttempts: num('MAX_SIGNATURE_ATTEMPTS', 3),
  },
  rateLimit: { verifyPerMinute: num('VERIFY_RATE_LIMIT_PER_MINUTE', 10) },
});

/**
 * Refuse to start production with development placeholders. A portal that signs
 * legal instruments should fail loudly rather than run with a known secret.
 */
export function assertProductionConfig(cfg: AppConfig): void {
  if (cfg.env !== 'production') return;
  const problems: string[] = [];
  if (cfg.auth.jwtSecret.includes('dev-only') || cfg.auth.jwtSecret.includes('change-me')) {
    problems.push('JWT_SECRET is a placeholder');
  }
  if (cfg.esign.callbackSecret.includes('dev-only') || cfg.esign.callbackSecret.includes('change-me')) {
    problems.push('ESIGN_CALLBACK_SECRET is a placeholder');
  }
  if (cfg.esign.provider === 'mock') problems.push('ESIGN_PROVIDER is still "mock" (DEC-002)');
  if (cfg.mail.transport === 'json') problems.push('SMTP_TRANSPORT is "json" — no mail would be sent');
  if (cfg.pdf.renderer !== 'playwright') problems.push('PDF_RENDERER is not "playwright"');

  /*
   * Storage is a NAS mountpoint. A relative path would resolve against whatever
   * directory systemd happened to start the service in, which is exactly how
   * agreements end up written to the local disk instead of the share.
   */
  if (!cfg.storage.fsRoot.startsWith('/')) {
    problems.push(`STORAGE_FS_ROOT must be an absolute path (got "${cfg.storage.fsRoot}")`);
  }
  if (/^\/(tmp|var\/tmp)(\/|$)/.test(cfg.storage.fsRoot)) {
    problems.push(`STORAGE_FS_ROOT points at temporary storage (${cfg.storage.fsRoot})`);
  }
  // The mount itself is verified at boot by FilesystemStorageDriver.onModuleInit,
  // which checks for the marker file that lives on the NAS.
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}
