import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { S3Client } from '@aws-sdk/client-s3';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', json: 'application/json',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', log: 'text/plain; charset=utf-8',
  wasm: 'application/wasm', woff2: 'font/woff2', parquet: 'application/vnd.apache.parquet', geojson: 'application/geo+json', tif: 'image/tiff', tiff: 'image/tiff',
};
export const mimeOf = (name) => MIME[path.extname(name || '').slice(1).toLowerCase()] ?? 'application/octet-stream';
export const isTextType = (ct = '') => /^text\/|json|xml|yaml|javascript|csv|markdown|svg/.test(ct);

export function createContext(cfg) {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken },
  });

  const bucket = (b) => {
    const name = b || cfg.defaultBucket;
    if (!name) throw new Error('bucket is required (no S3_BUCKET default configured)');
    if (cfg.allowedBuckets.length && !cfg.allowedBuckets.includes(name)) throw new Error(`bucket not allowed: ${name}`);
    return name;
  };

  // S3_PUBLIC_URL이 없으면 엔드포인트로 객체 주소를 만든다(경로 방식: endpoint/bucket/key, 가상 호스트 방식: bucket.host/key).
  // 버킷이 익명 읽기를 허용해야 열린다. 비공개 버킷은 presign_url을 쓴다.
  const endpointUrl = (b) => {
    if (cfg.endpoint) {
      const u = new URL(cfg.endpoint);
      if (cfg.forcePathStyle) return `${u.origin}${u.pathname.replace(/\/+$/, '')}/${b}`;
      return `${u.protocol}//${b}.${u.host}`;
    }
    return `https://${b}.s3.${cfg.region}.amazonaws.com`;
  };
  const publicUrl = (b, key) => {
    const enc = key.split('/').map(encodeURIComponent).join('/');
    if (cfg.publicUrl) {
      // S3_PUBLIC_URL은 기본 버킷의 공개 주소(CDN 등). {bucket}을 넣으면 모든 버킷에 적용된다.
      if (cfg.publicUrl.includes('{bucket}')) return `${cfg.publicUrl.replace('{bucket}', b)}/${enc}`;
      if (b === cfg.defaultBucket) return `${cfg.publicUrl}/${enc}`;
    }
    return `${endpointUrl(b)}/${enc}`;
  };

  const checkLocalPath = async (p, { mustExist = true } = {}) => {
    if (!path.isAbsolute(p)) throw new Error('path must be absolute');
    const real = mustExist ? await realpath(p) : path.resolve(p);
    const inside = (d) => real === d || real.startsWith(d.replace(/\/+$/, '') + '/');
    if (!cfg.allowedDirs.some(inside)) throw new Error(`path not allowed: ${real} (ALLOWED_DIRS=${cfg.allowedDirs.join(':')})`);
    return real;
  };

  return { cfg, s3, bucket, publicUrl, checkLocalPath };
}

const json = (obj) => JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
export const ok = (obj) => ({ content: [{ type: 'text', text: json(obj) }] });
export const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

const errText = (e) => {
  const code = e?.name || e?.Code;
  const status = e?.$metadata?.httpStatusCode;
  return [code, status && `HTTP ${status}`, e?.message].filter(Boolean).join(': ');
};

/**
 * 도구 등록 래퍼.
 * kind: 'read' | 'write' | 'destructive' — 읽기 전용·파괴적 작업 차단과 MCP annotations에 사용
 */
export function defineTools(server, ctx) {
  const { cfg } = ctx;
  const registered = [];
  const tool = (name, kind, description, inputSchema, handler) => {
    if (kind !== 'read' && cfg.readOnly) return;
    if (kind === 'destructive' && !cfg.allowDestructive) return;
    registered.push(name);
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: kind === 'read',
        destructiveHint: kind === 'destructive',
        openWorldHint: true,
      },
    }, async (args) => {
      try {
        return ok(await handler(args ?? {}));
      } catch (e) {
        return fail(`${name} failed — ${errText(e)}`);
      }
    });
  };
  return { tool, registered };
}
