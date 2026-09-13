import type { Operation, WeftClient } from "./client";
import type { LocalFile } from "./walk";

export interface RemoteFile {
  oid: string;
  mode: string;
}

/** Path relative to the published directory → what the tree holds there. */
export type RemoteTree = Map<string, RemoteFile>;

/** How many directory listings are in flight at once. */
const LISTING_CONCURRENCY = 8;

/**
 * Every blob under `prefix` at `tip`, by walking one directory per
 * request. The server's `?recursive=1` form answers paths only, without
 * object ids, and the id is the whole point: it is what lets a file
 * whose bytes have not changed be skipped.
 */
export async function listRemote(client: WeftClient, prefix: string, tip: string): Promise<RemoteTree> {
  const out: RemoteTree = new Map();
  const queue: string[] = [""];
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (queue.length === 0 && active === 0) return resolve();
      while (active < LISTING_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift()!;
        active += 1;
        const full = dir ? `${prefix}/${dir}` : prefix;
        client
          .tree(full, tip)
          .then((entries) => {
            for (const e of entries ?? []) {
              const rel = dir ? `${dir}/${e.name}` : e.name;
              if (e.kind === "tree") queue.push(rel);
              else out.set(rel, { oid: e.oid, mode: e.mode });
            }
            active -= 1;
            pump();
          })
          .catch((e) => {
            failed = true;
            reject(e);
          });
      }
    };
    pump();
  });
  return out;
}

export interface SizedOperation {
  op: Operation;
  /** Bytes the operation adds to a request body, as sent. */
  size: number;
  /** The local path, for messages. */
  path: string;
}

const PLAIN_FILE = "100644";

/**
 * The operations that turn the remote tree under `prefix` into the local
 * directory: a `put` for every file whose blob id or mode differs, a
 * `delete` for every remote path with no local file. A file that is
 * already there byte for byte, as a plain file, costs nothing.
 */
export function planOperations(local: LocalFile[], remote: RemoteTree, prefix: string): SizedOperation[] {
  const ops: SizedOperation[] = [];
  const seen = new Set<string>();
  for (const f of local) {
    seen.add(f.path);
    const have = remote.get(f.path);
    if (have && have.oid === f.oid && have.mode === PLAIN_FILE) continue;
    const path = `${prefix}/${f.path}`;
    if (f.text !== null) {
      const content = f.text;
      ops.push({ op: { op: "put", path, content }, size: Buffer.byteLength(JSON.stringify(content)), path: f.path });
    } else {
      const content = Buffer.from(f.bytes).toString("base64");
      ops.push({ op: { op: "put_base64", path, content }, size: content.length, path: f.path });
    }
  }
  for (const path of [...remote.keys()].sort()) {
    if (!seen.has(path)) ops.push({ op: { op: "delete", path: `${prefix}/${path}` }, size: 0, path });
  }
  return ops;
}

/** The server refuses a request with more operations than this. */
export const MAX_OPERATIONS = 10_000;
/** The server refuses a request body larger than this. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** What one request may spend on content and still fit under the body limit with its envelope. */
export const MAX_CHUNK_BYTES = MAX_REQUEST_BYTES - 1024 * 1024;

export class PlanRefusal extends Error {}

/** The chunk limits, checked before anything is read or sent. */
export function validateChunking(maxOps: number, maxBytes: number): void {
  if (!Number.isInteger(maxOps) || maxOps < 1 || maxOps > MAX_OPERATIONS) {
    throw new PlanRefusal(`chunk-operations must be between 1 and ${MAX_OPERATIONS}, got ${maxOps}`);
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHUNK_BYTES) {
    throw new PlanRefusal(`chunk-bytes must be between 1 and ${MAX_CHUNK_BYTES}, got ${maxBytes}`);
  }
}

/**
 * Greedy chunks of at most `maxOps` operations and about `maxBytes` of
 * content each. An operation larger than `maxBytes` travels alone; one
 * that cannot fit in any request at all is refused by name, before
 * anything is sent.
 */
export function chunk(ops: SizedOperation[], maxOps: number, maxBytes: number): SizedOperation[][] {
  validateChunking(maxOps, maxBytes);
  const chunks: SizedOperation[][] = [];
  let current: SizedOperation[] = [];
  let bytes = 0;
  for (const op of ops) {
    if (op.size > MAX_CHUNK_BYTES) {
      throw new PlanRefusal(
        `${op.path} is ${op.size} bytes as sent, and one request may carry at most ${MAX_REQUEST_BYTES}`,
      );
    }
    if (current.length > 0 && (current.length >= maxOps || bytes + op.size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += op.size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
