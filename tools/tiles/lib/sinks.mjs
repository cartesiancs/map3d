// Where published objects go: R2 (S3 API), a local folder (testing), or nowhere (--dry-run).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import https from "node:https";
import http from "node:http";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/** R2 through its S3 API. Credentials: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, endpoint from R2_ACCOUNT_ID (or R2_ENDPOINT). */
export function r2Sink({ bucket, concurrency }) {
  const env = process.env;
  const endpoint = env.R2_ENDPOINT ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
  if (!endpoint || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw new Error("set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write)");
  const agentOptions = { keepAlive: true, maxSockets: concurrency };
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    // R2 does not need the SDK's default CRC32 request checksums
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 8,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent(agentOptions),
      httpAgent: new http.Agent(agentOptions),
      connectionTimeout: 15_000,
      requestTimeout: 120_000,
    }),
  });
  return {
    name: `r2://${bucket} (${endpoint})`,
    async put(key, body, meta) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: meta.contentType,
          ContentEncoding: meta.contentEncoding,
          CacheControl: meta.cacheControl,
        }),
      );
    },
    /** body and metadata, or null when the key does not exist */
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { body: Buffer.from(await r.Body.transformToByteArray()), contentType: r.ContentType, cacheControl: r.CacheControl };
      } catch (err) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

/** Files under a folder (metadata in <file>.meta.json), for local tests. */
export function dirSink(root) {
  const made = new Set();
  const ensure = async (dir) => {
    if (made.has(dir)) return;
    await mkdir(dir, { recursive: true });
    made.add(dir);
  };
  return {
    name: `folder ${root}`,
    async put(key, body, meta) {
      const file = join(root, key);
      await ensure(dirname(file));
      await writeFile(file, body);
      await writeFile(file + ".meta.json", JSON.stringify(meta));
    },
    async get(key) {
      try {
        const body = await readFile(join(root, key));
        const meta = JSON.parse(await readFile(join(root, key) + ".meta.json", "utf8"));
        return { body, ...meta };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

/** Counts only. */
export function nullSink() {
  return { name: "nothing (dry run)", async put() {}, async get() { return null; } };
}

/** a sink from a plain description (worker threads build their own) */
export function makeSink(cfg) {
  if (cfg.kind === "r2") return r2Sink(cfg);
  if (cfg.kind === "dir") return dirSink(cfg.root);
  return nullSink();
}
