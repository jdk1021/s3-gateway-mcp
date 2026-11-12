const raw = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const required = (name) => {
  const v = raw(name);
  if (v === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};
const bool = (name, fallback) => {
  const v = raw(name);
  return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
};
const list = (name, fallback = '') => (raw(name, fallback) || '').split(/[,:]/).map((s) => s.trim()).filter(Boolean);

export function loadConfig({ transport }) {
  return {
    transport,
    port: Number(raw('PORT', '8000')),
    host: raw('HOST', '0.0.0.0'),
    // HTTP 모드에서는 토큰 필수. 의도적으로 끄려면 MCP_AUTH_DISABLED=true
    token: raw('MCP_TOKEN'),
    authDisabled: bool('MCP_AUTH_DISABLED', false),

    endpoint: raw('S3_ENDPOINT'),
    region: raw('S3_REGION', 'us-east-1'),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    sessionToken: raw('S3_SESSION_TOKEN'),

    defaultBucket: raw('S3_BUCKET'),
    allowedBuckets: list('S3_ALLOWED_BUCKETS'),
    publicUrl: raw('S3_PUBLIC_URL')?.replace(/\/+$/, ''),
    uploadPrefix: (raw('S3_PATH_PREFIX', '') || '').replace(/^\/+/, ''),

    readOnly: bool('S3_READ_ONLY', false),
    allowDestructive: bool('S3_ALLOW_DESTRUCTIVE', true),

    allowedDirs: list('ALLOWED_DIRS', process.cwd()),
    downloadDir: raw('DOWNLOAD_DIR'),
    maxBytes: Number(raw('MAX_UPLOAD_MB', '100')) * 1024 * 1024,
    maxInlineBytes: Number(raw('MAX_INLINE_KB', '1024')) * 1024,
  };
}
