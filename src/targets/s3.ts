/** AWS S3 and S3-compatible object-store target.
 *
 * The AWS SDK is deliberately loaded only when the target is used. Credentials are
 * therefore resolved by the SDK's normal credential chain and never enter config.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SyncTarget } from "./target.js";

export interface S3ClientLike {
  send(command: object): Promise<unknown>;
}

type S3Module = typeof import("@aws-sdk/client-s3");

export interface S3TargetOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Injectable client for tests and S3-compatible adapters. */
  client?: S3ClientLike;
}

export interface S3SyncError {
  path: string;
  error: string;
}

export interface S3SyncResult {
  uploaded: string[];
  skipped: string[];
  errors: S3SyncError[];
}

function normalizePrefix(prefix = ""): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function safeKey(path: string, prefix: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`invalid S3 target path: ${path}`);
  }
  return [normalizePrefix(prefix), normalized].filter(Boolean).join("/");
}

function md5(content: Buffer): string {
  return createHash("md5").update(content).digest("hex");
}

export class S3Target implements SyncTarget {
  private sdkPromise?: Promise<S3Module>;
  private clientPromise?: Promise<S3ClientLike>;

  constructor(private readonly options: S3TargetOptions) {
    if (!options.bucket.trim()) throw new Error("S3 target requires a bucket");
  }

  private async sdk(): Promise<S3Module> {
    this.sdkPromise ??= import("@aws-sdk/client-s3").catch(() => {
      throw new Error(
        "S3 target requires optional dependency @aws-sdk/client-s3; install it with `npm install @aws-sdk/client-s3`.",
      );
    });
    return this.sdkPromise;
  }

  private async client(): Promise<S3ClientLike> {
    this.clientPromise ??= this.options.client
      ? Promise.resolve(this.options.client)
      : this.sdk().then((sdk) => {
          const client = new sdk.S3Client({
            region: this.options.region ?? process.env.AWS_REGION ?? "us-east-1",
            endpoint: this.options.endpoint,
            forcePathStyle: this.options.forcePathStyle,
          });
          return client as unknown as S3ClientLike;
        });
    return this.clientPromise;
  }

  async write(path: string, content: Buffer | string): Promise<void> {
    await this.writeIfChanged(path, content);
  }

  async writeIfChanged(path: string, content: Buffer | string): Promise<boolean> {
    const sdk = await this.sdk();
    const client = await this.client();
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const bucket = this.options.bucket;
    const key = safeKey(path, this.options.prefix ?? "");
    try {
      const head = (await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key }))) as {
        ETag?: string;
      };
      if (head.ETag?.replaceAll('"', "") === md5(body)) return false;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status !== 404 && status !== 403) throw error;
    }

    const tempKey = `${key}.sheaf-upload-${process.pid}-${Date.now()}`;
    try {
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: tempKey, Body: body }));
      await client.send(
        new sdk.CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `${this.options.bucket}/${encodeURIComponent(tempKey).replaceAll("%2F", "/")}`,
        }),
      );
    } finally {
      await client
        .send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: tempKey }))
        .catch(() => undefined);
    }
    return true;
  }

  async delete(path: string): Promise<void> {
    const sdk = await this.sdk();
    const client = await this.client();
    const bucket = this.options.bucket;
    await client.send(
      new sdk.DeleteObjectCommand({
        Bucket: bucket,
        Key: safeKey(path, this.options.prefix ?? ""),
      }),
    );
  }

  async list(prefix?: string): Promise<string[]> {
    const sdk = await this.sdk();
    const client = await this.client();
    const bucket = this.options.bucket;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = (await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: safeKey(prefix ?? "", this.options.prefix ?? ""),
          ContinuationToken: token,
        }),
      )) as {
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        const storagePrefix = normalizePrefix(this.options.prefix ?? "");
        keys.push(
          storagePrefix && item.Key.startsWith(`${storagePrefix}/`)
            ? item.Key.slice(storagePrefix.length + 1)
            : item.Key,
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}

export function createS3Target(options: S3TargetOptions): SyncTarget {
  return new S3Target(options);
}

/** Uploads rendered files independently; one object failure does not abort its siblings. */
export async function syncDirectoryToS3(
  outDir: string,
  files: readonly string[],
  options: S3TargetOptions,
): Promise<S3SyncResult> {
  const target = new S3Target(options);
  const result: S3SyncResult = { uploaded: [], skipped: [], errors: [] };
  for (const path of files) {
    try {
      const changed = await target.writeIfChanged(path, await readFile(join(outDir, path)));
      (changed ? result.uploaded : result.skipped).push(path);
    } catch (error) {
      result.errors.push({ path, error: (error as Error).message });
    }
  }
  return result;
}

export function s3ObjectPath(path: string, prefix = ""): string {
  return posix.join(normalizePrefix(prefix), path.replaceAll("\\", "/"));
}
