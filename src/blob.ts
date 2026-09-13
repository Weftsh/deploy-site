import { createHash } from "node:crypto";

/**
 * The object id git records for a file's bytes: SHA-1 over
 * `blob <len>\0<bytes>`. Weft's tree listing reports this per entry, so
 * a file whose bytes have not changed can be recognised without sending
 * it, and without any state kept between runs.
 */
export function blobOid(bytes: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`blob ${bytes.byteLength}\0`);
  h.update(bytes);
  return h.digest("hex");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Whether bytes can travel as a `put` (a JSON string, decoded on the
 * server as UTF-8 into the same bytes) rather than a `put_base64`.
 * Valid UTF-8 with no NUL round-trips exactly; anything else is sent
 * base64 so the blob id the server computes is the one computed here.
 */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
