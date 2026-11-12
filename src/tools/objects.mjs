import { z } from 'zod';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile, mkdir } from 'node:fs/promises';
import {
  ListObjectsV2Command, ListObjectVersionsCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
  CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
  GetObjectTaggingCommand, PutObjectTaggingCommand, DeleteObjectTaggingCommand,
  ListMultipartUploadsCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mimeOf, isTextType } from '../context.mjs';

const bucketArg = z.string().optional().describe('Bucket name. Defaults to S3_BUCKET.');
const keyArg = z.string().min(1).describe('Object key');
const versionArg = z.string().optional().describe('Version ID (versioned buckets)');
const metaArg = z.record(z.string(), z.string()).optional().describe('User metadata (x-amz-meta-*)');
const tagsArg = z.record(z.string(), z.string());

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const safeName = (n) => path.basename(n || 'file').replace(/[^\w.\-가-힣]+/g, '_').slice(-120) || 'file';
const tagString = (tags) => (tags ? new URLSearchParams(tags).toString() : undefined);

export function registerObjectTools({ tool }, ctx) {
  const { s3, bucket, cfg, publicUrl, checkLocalPath } = ctx;

  // 키를 지정하면 그대로, 생략하면 {prefix}{YYYYMMDD}/{rand}-{name}
  const autoKey = (name, key) => (key ? key.replace(/^\/+/, '') : `${cfg.uploadPrefix}${today()}/${randomBytes(3).toString('hex')}-${safeName(name)}`);

  const upload = async ({ b, key, body, size, contentType, metadata, tags, cacheControl }) => {
    if (size > cfg.maxBytes) throw new Error(`too large: ${size} bytes (MAX_UPLOAD_MB=${cfg.maxBytes / 1048576})`);
    // lib-storage가 5MB 넘으면 자동으로 멀티파트 업로드
    await new Upload({
      client: s3,
      params: { Bucket: b, Key: key, Body: body, ContentType: contentType, Metadata: metadata, Tagging: tagString(tags), CacheControl: cacheControl },
      queueSize: 4, partSize: 8 * 1024 * 1024,
    }).done();
    return { bucket: b, key, size, content_type: contentType, url: publicUrl(b, key) ?? null };
  };

  // --- listing
  tool('list_objects', 'read',
    'List objects (ListObjectsV2). Use delimiter "/" to browse like folders; pass continuation_token to page.',
    {
      bucket: bucketArg, prefix: z.string().optional(), delimiter: z.string().optional(),
      max_keys: z.number().int().min(1).max(1000).default(100), continuation_token: z.string().optional(),
      start_after: z.string().optional(),
    }, async (a) => {
      const b = bucket(a.bucket);
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: b, Prefix: a.prefix, Delimiter: a.delimiter, MaxKeys: a.max_keys,
        ContinuationToken: a.continuation_token, StartAfter: a.start_after,
      }));
      return {
        bucket: b, prefix: a.prefix ?? '',
        folders: (r.CommonPrefixes ?? []).map((p) => p.Prefix),
        objects: (r.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size, last_modified: o.LastModified, etag: o.ETag, storage_class: o.StorageClass })),
        is_truncated: !!r.IsTruncated, next_continuation_token: r.NextContinuationToken ?? null,
      };
    });

  tool('list_object_versions', 'read', 'List object versions and delete markers.', {
    bucket: bucketArg, prefix: z.string().optional(), max_keys: z.number().int().min(1).max(1000).default(100),
    key_marker: z.string().optional(), version_id_marker: z.string().optional(),
  }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new ListObjectVersionsCommand({
      Bucket: b, Prefix: a.prefix, MaxKeys: a.max_keys, KeyMarker: a.key_marker, VersionIdMarker: a.version_id_marker,
    }));
    return {
      bucket: b,
      versions: (r.Versions ?? []).map((v) => ({ key: v.Key, version_id: v.VersionId, is_latest: v.IsLatest, size: v.Size, last_modified: v.LastModified })),
      delete_markers: (r.DeleteMarkers ?? []).map((d) => ({ key: d.Key, version_id: d.VersionId, is_latest: d.IsLatest, last_modified: d.LastModified })),
      is_truncated: !!r.IsTruncated, next_key_marker: r.NextKeyMarker ?? null, next_version_id_marker: r.NextVersionIdMarker ?? null,
    };
  });

  tool('head_object', 'read', 'Get object metadata without downloading it.', { bucket: bucketArg, key: keyArg, version_id: versionArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new HeadObjectCommand({ Bucket: b, Key: a.key, VersionId: a.version_id }));
    return {
      bucket: b, key: a.key, size: r.ContentLength, content_type: r.ContentType, etag: r.ETag, last_modified: r.LastModified,
      version_id: r.VersionId ?? null, storage_class: r.StorageClass ?? 'STANDARD', cache_control: r.CacheControl ?? null,
      metadata: r.Metadata ?? {}, url: publicUrl(b, a.key) ?? null,
    };
  });

  // --- read
  tool('get_object', 'read',
    `Download an object. Text is returned inline, binary as base64 (up to MAX_INLINE_KB=${cfg.maxInlineBytes / 1024}). ` +
    'Set save_to (absolute path under DOWNLOAD_DIR) to write it to disk instead. Use range like "bytes=0-1023" for partial reads.',
    {
      bucket: bucketArg, key: keyArg, version_id: versionArg, range: z.string().optional(),
      save_to: z.string().optional(), as: z.enum(['auto', 'text', 'base64']).default('auto'),
    }, async (a) => {
      const b = bucket(a.bucket);
      const r = await s3.send(new GetObjectCommand({ Bucket: b, Key: a.key, VersionId: a.version_id, Range: a.range }));
      const ct = r.ContentType || mimeOf(a.key);
      if (a.save_to) {
        if (!cfg.downloadDir) throw new Error('save_to requires DOWNLOAD_DIR to be configured');
        const dest = path.resolve(a.save_to);
        if (!dest.startsWith(cfg.downloadDir.replace(/\/+$/, '') + '/')) throw new Error(`save_to must be inside DOWNLOAD_DIR (${cfg.downloadDir})`);
        await mkdir(path.dirname(dest), { recursive: true });
        const bytes = await r.Body.transformToByteArray();
        await writeFile(dest, bytes);
        return { bucket: b, key: a.key, saved_to: dest, size: bytes.length, content_type: ct };
      }
      if ((r.ContentLength ?? 0) > cfg.maxInlineBytes) {
        r.Body.destroy?.();
        throw new Error(`object is ${r.ContentLength} bytes, over MAX_INLINE_KB. Use range, save_to, or presign_url.`);
      }
      const bytes = Buffer.from(await r.Body.transformToByteArray());
      const asText = a.as === 'text' || (a.as === 'auto' && isTextType(ct));
      return {
        bucket: b, key: a.key, size: bytes.length, content_type: ct, encoding: asText ? 'utf8' : 'base64',
        content: asText ? bytes.toString('utf8') : bytes.toString('base64'),
      };
    });

  tool('presign_url', 'read', 'Create a presigned URL to download (GET) or upload (PUT) an object without credentials.', {
    bucket: bucketArg, key: keyArg, method: z.enum(['GET', 'PUT']).default('GET'),
    expires_in: z.number().int().min(1).max(604800).default(3600).describe('Seconds, max 7 days'),
    content_type: z.string().optional().describe('PUT only: Content-Type the uploader must send'),
    download_filename: z.string().optional().describe('GET only: force Content-Disposition attachment filename'),
  }, async (a) => {
    const b = bucket(a.bucket);
    if (a.method === 'PUT' && cfg.readOnly) throw new Error('PUT presign is disabled in read-only mode');
    const cmd = a.method === 'PUT'
      ? new PutObjectCommand({ Bucket: b, Key: a.key, ContentType: a.content_type })
      : new GetObjectCommand({
        Bucket: b, Key: a.key,
        ResponseContentDisposition: a.download_filename ? `attachment; filename*=UTF-8''${encodeURIComponent(a.download_filename)}` : undefined,
      });
    const url = await getSignedUrl(s3, cmd, { expiresIn: a.expires_in });
    return { bucket: b, key: a.key, method: a.method, url, expires_at: new Date(Date.now() + a.expires_in * 1000).toISOString() };
  });

  tool('get_public_url', 'read',
    'Return the direct URL for a key (S3_PUBLIC_URL if set, otherwise built from the endpoint). Opens only if the bucket allows anonymous reads; use presign_url for private buckets. Does not check existence.',
    { bucket: bucketArg, key: keyArg }, async (a) => {
      const b = bucket(a.bucket);
      return { bucket: b, key: a.key, url: publicUrl(b, a.key) };
    });

  // --- write
  const putCommon = {
    bucket: bucketArg, content_type: z.string().optional(), metadata: metaArg,
    tags: tagsArg.optional(), cache_control: z.string().optional(),
  };

  tool('put_object', 'write',
    'Write an object with an exact key from text or base64 content. For local files prefer upload_file.',
    {
      ...putCommon, key: keyArg,
      text: z.string().optional().describe('UTF-8 content'),
      base64: z.string().optional().describe('Base64 content (data: URI allowed)'),
    }, async (a) => {
      if ((a.text === undefined) === (a.base64 === undefined)) throw new Error('provide exactly one of text or base64');
      const b = bucket(a.bucket);
      let body; let ct = a.content_type;
      if (a.text !== undefined) body = Buffer.from(a.text, 'utf8');
      else {
        const m = a.base64.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s);
        body = Buffer.from(m ? m[2] : a.base64, 'base64');
        ct ||= m?.[1];
      }
      return upload({ b, key: a.key, body, size: body.length, contentType: ct || mimeOf(a.key), metadata: a.metadata, tags: a.tags, cacheControl: a.cache_control });
    });

  tool('upload_file', 'write',
    'Upload a local file and return its public URL. Large files use multipart automatically. ' +
    `Without key, stores as ${cfg.uploadPrefix}YYYYMMDD/<random>-<filename>. Allowed dirs: ${cfg.allowedDirs.join(', ')}.`,
    { ...putCommon, file_path: z.string().describe('Absolute path'), key: z.string().optional() }, async (a) => {
      const b = bucket(a.bucket);
      const real = await checkLocalPath(a.file_path);
      const st = await stat(real);
      if (!st.isFile()) throw new Error('not a regular file');
      return upload({
        b, key: autoKey(real, a.key), body: createReadStream(real), size: st.size,
        contentType: a.content_type || mimeOf(real), metadata: a.metadata, tags: a.tags, cacheControl: a.cache_control,
      });
    });

  tool('upload_from_url', 'write', 'Fetch a remote http(s) file and store it; returns its public URL.', {
    ...putCommon, url: z.string().url(), key: z.string().optional(), filename: z.string().optional(),
  }, async (a) => {
    const b = bucket(a.bucket);
    const u = new URL(a.url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https URLs');
    const res = await fetch(u, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > cfg.maxBytes) throw new Error(`too large: ${len} bytes`);
    const body = Buffer.from(await res.arrayBuffer());
    const name = a.filename || decodeURIComponent(path.basename(u.pathname)) || 'download';
    const remoteCt = res.headers.get('content-type')?.split(';')[0];
    return upload({
      b, key: autoKey(name, a.key), body, size: body.length,
      contentType: a.content_type || (remoteCt && remoteCt !== 'application/octet-stream' ? remoteCt : mimeOf(name)),
      metadata: a.metadata, tags: a.tags, cacheControl: a.cache_control,
    });
  });

  tool('copy_object', 'write', 'Copy an object (server-side), optionally across buckets.', {
    source_bucket: bucketArg, source_key: keyArg, source_version_id: versionArg,
    dest_bucket: bucketArg, dest_key: keyArg,
    metadata: metaArg.describe('If set, replaces metadata on the copy'), content_type: z.string().optional(),
  }, async (a) => {
    const sb = bucket(a.source_bucket); const db = bucket(a.dest_bucket);
    const src = `${sb}/${a.source_key.split('/').map(encodeURIComponent).join('/')}${a.source_version_id ? `?versionId=${a.source_version_id}` : ''}`;
    const replace = !!(a.metadata || a.content_type);
    const r = await s3.send(new CopyObjectCommand({
      Bucket: db, Key: a.dest_key, CopySource: src,
      ...(replace ? { MetadataDirective: 'REPLACE', Metadata: a.metadata, ContentType: a.content_type || mimeOf(a.dest_key) } : {}),
    }));
    return { from: `${sb}/${a.source_key}`, to: `${db}/${a.dest_key}`, etag: r.CopyObjectResult?.ETag, url: publicUrl(db, a.dest_key) ?? null };
  });

  // --- delete
  tool('delete_object', 'destructive', 'Delete one object (or one version).', { bucket: bucketArg, key: keyArg, version_id: versionArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new DeleteObjectCommand({ Bucket: b, Key: a.key, VersionId: a.version_id }));
    return { bucket: b, deleted: a.key, version_id: r.VersionId ?? a.version_id ?? null, delete_marker: !!r.DeleteMarker };
  });

  tool('move_object', 'destructive', 'Move/rename an object: server-side copy, then delete the source.', {
    source_bucket: bucketArg, source_key: keyArg, dest_bucket: bucketArg, dest_key: keyArg,
  }, async (a) => {
    const sb = bucket(a.source_bucket); const db = bucket(a.dest_bucket);
    await s3.send(new CopyObjectCommand({ Bucket: db, Key: a.dest_key, CopySource: `${sb}/${a.source_key.split('/').map(encodeURIComponent).join('/')}` }));
    await s3.send(new DeleteObjectCommand({ Bucket: sb, Key: a.source_key }));
    return { from: `${sb}/${a.source_key}`, to: `${db}/${a.dest_key}`, url: publicUrl(db, a.dest_key) ?? null };
  });

  tool('delete_objects', 'destructive',
    'Batch delete. Pass keys, or a prefix with confirm=true to delete everything under it (max 10,000 per call).',
    {
      bucket: bucketArg, keys: z.array(z.string()).max(1000).optional(),
      prefix: z.string().min(1).optional(), confirm: z.boolean().default(false),
    }, async (a) => {
      const b = bucket(a.bucket);
      let keys = a.keys ?? [];
      if (a.prefix) {
        if (!a.confirm) throw new Error('prefix delete requires confirm=true');
        let token;
        do {
          const r = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: a.prefix, ContinuationToken: token }));
          keys.push(...(r.Contents ?? []).map((o) => o.Key));
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token && keys.length < 10000);
      }
      if (!keys.length) return { bucket: b, deleted: 0, errors: [] };
      const deleted = []; const errors = [];
      for (let i = 0; i < keys.length; i += 1000) {
        const r = await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: false } }));
        deleted.push(...(r.Deleted ?? []).map((d) => d.Key));
        errors.push(...(r.Errors ?? []).map((e) => ({ key: e.Key, code: e.Code, message: e.Message })));
      }
      return { bucket: b, deleted: deleted.length, keys: deleted.slice(0, 50), errors };
    });

  // --- tagging
  tool('get_object_tagging', 'read', 'Get object tags.', { bucket: bucketArg, key: keyArg, version_id: versionArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new GetObjectTaggingCommand({ Bucket: b, Key: a.key, VersionId: a.version_id }));
    return { bucket: b, key: a.key, tags: Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key, t.Value])) };
  });
  tool('put_object_tagging', 'write', 'Replace object tags.', { bucket: bucketArg, key: keyArg, version_id: versionArg, tags: tagsArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new PutObjectTaggingCommand({
      Bucket: b, Key: a.key, VersionId: a.version_id,
      Tagging: { TagSet: Object.entries(a.tags).map(([Key, Value]) => ({ Key, Value })) },
    }));
    return { bucket: b, key: a.key, tags: a.tags };
  });
  tool('delete_object_tagging', 'destructive', 'Remove all object tags.', { bucket: bucketArg, key: keyArg, version_id: versionArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteObjectTaggingCommand({ Bucket: b, Key: a.key, VersionId: a.version_id }));
    return { bucket: b, key: a.key, deleted: 'tags' };
  });

  // --- multipart housekeeping
  tool('list_multipart_uploads', 'read', 'List in-progress multipart uploads (unfinished uploads still use storage).', {
    bucket: bucketArg, prefix: z.string().optional(),
  }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new ListMultipartUploadsCommand({ Bucket: b, Prefix: a.prefix }));
    return { bucket: b, uploads: (r.Uploads ?? []).map((u) => ({ key: u.Key, upload_id: u.UploadId, initiated: u.Initiated })) };
  });
  tool('abort_multipart_upload', 'destructive', 'Abort an in-progress multipart upload and free its parts.', {
    bucket: bucketArg, key: keyArg, upload_id: z.string(),
  }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new AbortMultipartUploadCommand({ Bucket: b, Key: a.key, UploadId: a.upload_id }));
    return { bucket: b, key: a.key, aborted: a.upload_id };
  });
}
