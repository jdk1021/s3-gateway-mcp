import { z } from 'zod';
import {
  ListBucketsCommand, CreateBucketCommand, DeleteBucketCommand, HeadBucketCommand, GetBucketLocationCommand,
  GetBucketPolicyCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand,
  GetBucketVersioningCommand, PutBucketVersioningCommand,
  GetBucketCorsCommand, PutBucketCorsCommand, DeleteBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, DeleteBucketLifecycleCommand,
  GetBucketTaggingCommand, PutBucketTaggingCommand, DeleteBucketTaggingCommand,
  GetBucketEncryptionCommand, PutBucketEncryptionCommand, DeleteBucketEncryptionCommand,
} from '@aws-sdk/client-s3';

const bucketArg = z.string().optional().describe('Bucket name. Defaults to S3_BUCKET.');
const tagsArg = z.record(z.string(), z.string()).describe('Tags as {"key": "value"}');

// 설정이 없을 때 S3가 돌려주는 오류는 "없음"으로 정규화
const orEmpty = async (p, codes) => {
  try { return await p; } catch (e) { if (codes.includes(e?.name) || codes.includes(e?.Code)) return null; throw e; }
};

export function registerBucketTools({ tool }, ctx) {
  const { s3, bucket, cfg } = ctx;

  tool('list_buckets', 'read', 'List all buckets visible to the configured credentials.', {}, async () => {
    const r = await s3.send(new ListBucketsCommand({}));
    let buckets = (r.Buckets ?? []).map((b) => ({ name: b.Name, created: b.CreationDate }));
    if (cfg.allowedBuckets.length) buckets = buckets.filter((b) => cfg.allowedBuckets.includes(b.name));
    return { count: buckets.length, default_bucket: cfg.defaultBucket ?? null, buckets };
  });

  tool('head_bucket', 'read', 'Check that a bucket exists and is accessible; returns its region.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new HeadBucketCommand({ Bucket: b }));
    const loc = await orEmpty(s3.send(new GetBucketLocationCommand({ Bucket: b })), ['NotImplemented']);
    return { bucket: b, exists: true, region: loc?.LocationConstraint || cfg.region };
  });

  tool('create_bucket', 'write', 'Create a bucket.', {
    bucket: z.string(), region: z.string().optional().describe('LocationConstraint; omit for the default region'),
  }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new CreateBucketCommand({
      Bucket: b,
      ...(a.region && a.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: a.region } } : {}),
    }));
    return { created: b };
  });

  tool('delete_bucket', 'destructive', 'Delete an empty bucket.', { bucket: z.string() }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketCommand({ Bucket: b }));
    return { deleted: b };
  });

  // --- policy
  tool('get_bucket_policy', 'read', 'Get the bucket policy JSON.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await orEmpty(s3.send(new GetBucketPolicyCommand({ Bucket: b })), ['NoSuchBucketPolicy']);
    return { bucket: b, policy: r?.Policy ? JSON.parse(r.Policy) : null };
  });
  tool('put_bucket_policy', 'write', 'Replace the bucket policy.', {
    bucket: bucketArg, policy: z.union([z.string(), z.record(z.string(), z.any())]).describe('Policy document (JSON object or string)'),
  }, async (a) => {
    const b = bucket(a.bucket);
    const Policy = typeof a.policy === 'string' ? a.policy : JSON.stringify(a.policy);
    await s3.send(new PutBucketPolicyCommand({ Bucket: b, Policy }));
    return { bucket: b, updated: 'policy' };
  });
  tool('delete_bucket_policy', 'destructive', 'Remove the bucket policy.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: b }));
    return { bucket: b, deleted: 'policy' };
  });

  // --- versioning
  tool('get_bucket_versioning', 'read', 'Get versioning status.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await s3.send(new GetBucketVersioningCommand({ Bucket: b }));
    return { bucket: b, status: r.Status ?? 'Unversioned', mfa_delete: r.MFADelete ?? null };
  });
  tool('put_bucket_versioning', 'write', 'Enable or suspend versioning.', {
    bucket: bucketArg, status: z.enum(['Enabled', 'Suspended']),
  }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new PutBucketVersioningCommand({ Bucket: b, VersioningConfiguration: { Status: a.status } }));
    return { bucket: b, status: a.status };
  });

  // --- CORS
  const corsRule = z.object({
    AllowedMethods: z.array(z.string()), AllowedOrigins: z.array(z.string()),
    AllowedHeaders: z.array(z.string()).optional(), ExposeHeaders: z.array(z.string()).optional(),
    MaxAgeSeconds: z.number().int().optional(), ID: z.string().optional(),
  });
  tool('get_bucket_cors', 'read', 'Get CORS rules.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await orEmpty(s3.send(new GetBucketCorsCommand({ Bucket: b })), ['NoSuchCORSConfiguration']);
    return { bucket: b, rules: r?.CORSRules ?? [] };
  });
  tool('put_bucket_cors', 'write', 'Replace CORS rules.', { bucket: bucketArg, rules: z.array(corsRule) }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new PutBucketCorsCommand({ Bucket: b, CORSConfiguration: { CORSRules: a.rules } }));
    return { bucket: b, updated: 'cors', rules: a.rules.length };
  });
  tool('delete_bucket_cors', 'destructive', 'Remove all CORS rules.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketCorsCommand({ Bucket: b }));
    return { bucket: b, deleted: 'cors' };
  });

  // --- lifecycle
  tool('get_bucket_lifecycle', 'read', 'Get lifecycle rules.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await orEmpty(s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: b })), ['NoSuchLifecycleConfiguration']);
    return { bucket: b, rules: r?.Rules ?? [] };
  });
  tool('put_bucket_lifecycle', 'write',
    'Replace lifecycle rules. Rules use the S3 API shape, e.g. [{"ID":"expire-tmp","Status":"Enabled","Filter":{"Prefix":"tmp/"},"Expiration":{"Days":7}}].',
    { bucket: bucketArg, rules: z.array(z.record(z.string(), z.any())) }, async (a) => {
      const b = bucket(a.bucket);
      await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: b, LifecycleConfiguration: { Rules: a.rules } }));
      return { bucket: b, updated: 'lifecycle', rules: a.rules.length };
    });
  tool('delete_bucket_lifecycle', 'destructive', 'Remove all lifecycle rules.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketLifecycleCommand({ Bucket: b }));
    return { bucket: b, deleted: 'lifecycle' };
  });

  // --- tagging
  tool('get_bucket_tagging', 'read', 'Get bucket tags.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await orEmpty(s3.send(new GetBucketTaggingCommand({ Bucket: b })), ['NoSuchTagSet', 'NoSuchTagSetError']);
    return { bucket: b, tags: Object.fromEntries((r?.TagSet ?? []).map((t) => [t.Key, t.Value])) };
  });
  tool('put_bucket_tagging', 'write', 'Replace bucket tags.', { bucket: bucketArg, tags: tagsArg }, async (a) => {
    const b = bucket(a.bucket);
    const TagSet = Object.entries(a.tags).map(([Key, Value]) => ({ Key, Value }));
    await s3.send(new PutBucketTaggingCommand({ Bucket: b, Tagging: { TagSet } }));
    return { bucket: b, tags: a.tags };
  });
  tool('delete_bucket_tagging', 'destructive', 'Remove all bucket tags.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketTaggingCommand({ Bucket: b }));
    return { bucket: b, deleted: 'tags' };
  });

  // --- encryption
  tool('get_bucket_encryption', 'read', 'Get default server-side encryption.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    const r = await orEmpty(s3.send(new GetBucketEncryptionCommand({ Bucket: b })),
      ['ServerSideEncryptionConfigurationNotFoundError']);
    return { bucket: b, rules: r?.ServerSideEncryptionConfiguration?.Rules ?? [] };
  });
  tool('put_bucket_encryption', 'write', 'Set default server-side encryption.', {
    bucket: bucketArg, algorithm: z.enum(['AES256', 'aws:kms']).default('AES256'), kms_key_id: z.string().optional(),
  }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new PutBucketEncryptionCommand({
      Bucket: b,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: {
        SSEAlgorithm: a.algorithm, ...(a.kms_key_id ? { KMSMasterKeyID: a.kms_key_id } : {}),
      } }] },
    }));
    return { bucket: b, algorithm: a.algorithm };
  });
  tool('delete_bucket_encryption', 'destructive', 'Remove default encryption.', { bucket: bucketArg }, async (a) => {
    const b = bucket(a.bucket);
    await s3.send(new DeleteBucketEncryptionCommand({ Bucket: b }));
    return { bucket: b, deleted: 'encryption' };
  });
}
