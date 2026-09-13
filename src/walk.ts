import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { asText, blobOid } from "./blob";

export interface LocalFile {
  /** Forward-slash path relative to the walked directory. */
  path: string;
  bytes: Uint8Array;
  /** git blob id of `bytes`. */
  oid: string;
  /** The bytes as a string when they may travel as a `put`; null means `put_base64`. */
  text: string | null;
}

/** A refusal the walk makes on purpose, naming the path. The step fails with this sentence. */
export class WalkRefusal extends Error {}

const EXEC_BITS = 0o111;

/**
 * Every regular file under `dir`, in a stable order. Refuses, by name,
 * what the commit API cannot carry rather than quietly changing it: a
 * symlink (the API writes bytes, never a link, and a site never follows
 * one), an executable (only mode 100644 is written, so the bit would be
 * lost silently), a `.git` segment (rejected by the server), and an
 * empty directory (publishing nothing is never what a build meant).
 */
export async function walkDirectory(dir: string): Promise<LocalFile[]> {
  let top;
  try {
    top = await lstat(dir);
  } catch {
    throw new WalkRefusal(`directory ${dir} does not exist`);
  }
  if (top.isSymbolicLink()) throw new WalkRefusal(`directory ${dir} is a symlink`);
  if (!top.isDirectory()) throw new WalkRefusal(`${dir} is not a directory`);
  const out: LocalFile[] = [];
  await walk(dir, "", out);
  if (out.length === 0) throw new WalkRefusal(`directory ${dir} is empty; nothing to publish`);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walk(root: string, rel: string, out: LocalFile[]): Promise<void> {
  const here = rel ? join(root, rel) : root;
  const names = await readdir(here);
  for (const name of names) {
    const relPath = rel ? `${rel}/${name}` : name;
    const abs = join(root, relPath);
    if (name === "." || name === "..") continue;
    if (name === ".git") {
      throw new WalkRefusal(`${relPath} is a .git entry; the commit API rejects that path`);
    }
    if (name.includes("\0")) throw new WalkRefusal(`${relPath} contains a NUL byte`);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new WalkRefusal(`${relPath} is a symlink; the commit API writes bytes, never links`);
    }
    if (st.isDirectory()) {
      await walk(root, relPath, out);
      continue;
    }
    if (!st.isFile()) throw new WalkRefusal(`${relPath} is not a regular file`);
    if (st.mode & EXEC_BITS) {
      throw new WalkRefusal(
        `${relPath} is executable; the commit API only writes mode 100644, so the bit would be lost`,
      );
    }
    const bytes = new Uint8Array(await readFile(abs));
    out.push({ path: relPath, bytes, oid: blobOid(bytes), text: asText(bytes) });
  }
}
