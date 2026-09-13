/**
 * A small in-memory Weft: the routes the action uses, answering the
 * shapes and statuses the server's own handlers answer
 * (commits.rs, refops_api.rs, reads.rs, sites_api.rs). It records every
 * request so a test can assert on what travelled, and every move of a
 * branch so a test can prove the published branch never held a partial
 * tree.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { blobOid } from "../src/blob";

export interface Entry {
  oid: string;
  mode: string;
}
export type Tree = Map<string, Entry>;

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface Move {
  branch: string;
  oid: string;
  tree: Tree;
}

export class FakeWeft {
  readonly branches = new Map<string, string>();
  readonly commits = new Map<string, { tree: Tree; parent: string | null; message: string }>();
  readonly requests: Recorded[] = [];
  readonly moves: Move[] = [];
  /** Answers instead of the commit route when it returns something; once per install. */
  beforeCommit: ((body: any) => { status: number; body: unknown } | undefined) | null = null;
  sitesDomain: string | null = "sites.example";
  siteConfig: { publish: string; branch: string | null } | null = { publish: "dist", branch: "weft-site" };
  siteConfigError: string | null = null;
  bodyLimit = 64 * 1024 * 1024;
  readonly token = "weft_01test_secret";
  readonly org = "acme";
  readonly repo = "site";
  private server: Server | null = null;
  private counter = 0;

  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server!.close(() => r()));
  }

  treeOf(branch: string): Tree {
    const oid = this.branches.get(branch);
    if (!oid) throw new Error(`no branch ${branch}`);
    return this.commits.get(oid)!.tree;
  }

  /** Files under `prefix/` as path → decoded bytes are not kept; this is path → blob oid. */
  filesUnder(branch: string, prefix: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [p, e] of this.treeOf(branch)) {
      if (p.startsWith(`${prefix}/`)) out.set(p.slice(prefix.length + 1), e.oid);
    }
    return out;
  }

  /** Seed a commit directly, as if pushed. */
  seed(branch: string, files: Record<string, string | Uint8Array>, modes: Record<string, string> = {}): string {
    const tree: Tree = new Map();
    for (const [p, c] of Object.entries(files)) {
      const bytes = typeof c === "string" ? new TextEncoder().encode(c) : c;
      tree.set(p, { oid: blobOid(bytes), mode: modes[p] ?? "100644" });
    }
    const oid = this.newCommit(tree, this.branches.get(branch) ?? null, "seed");
    this.branches.set(branch, oid);
    return oid;
  }

  private newCommit(tree: Tree, parent: string | null, message: string): string {
    this.counter += 1;
    const h = createHash("sha1");
    h.update(`${parent}\n${message}\n${this.counter}\n`);
    for (const [p, e] of [...tree].sort()) h.update(`${p} ${e.mode} ${e.oid}\n`);
    const oid = h.digest("hex");
    this.commits.set(oid, { tree, parent, message });
    return oid;
  }

  private setBranch(branch: string, oid: string) {
    this.branches.set(branch, oid);
    this.moves.push({ branch, oid, tree: new Map(this.commits.get(oid)!.tree) });
  }

  private resolve(rev: string): string | null {
    if (/^[0-9a-f]{40}$/.test(rev)) return this.commits.has(rev) ? rev : null;
    if (rev.startsWith("refs/heads/")) rev = rev.slice("refs/heads/".length);
    return this.branches.get(rev) ?? null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (status: number, payload?: unknown): void => {
      res.statusCode = status;
      if (payload === undefined) {
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (size > this.bodyLimit) return send(413, { error: "length limit exceeded" });
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: "unauthorized" });
    const u = new URL(req.url!, "http://x");
    const base = `/v1/orgs/${this.org}/repos/${this.repo}`;
    if (!u.pathname.startsWith(base)) return send(404, { error: "no such repository" });
    const route = u.pathname.slice(base.length);
    const m = req.method;

    if (m === "GET" && route === "/branches") {
      const branches = [...this.branches]
        .map(([name, oid]) => ({ name, full: `refs/heads/${name}`, oid, default: name === "main" }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(200, { branches, head: "refs/heads/main" });
    }
    if (m === "GET" && (route === "/tree" || route.startsWith("/tree/"))) {
      const at = u.searchParams.get("at") ?? "HEAD";
      const commit = this.resolve(at);
      if (!commit) return send(404, { error: `unknown rev ${JSON.stringify(at)}` });
      const dir = route === "/tree" ? "" : decodeURIComponent(route.slice("/tree/".length));
      const tree = this.commits.get(commit)!.tree;
      const prefix = dir ? `${dir}/` : "";
      if (dir && tree.has(dir)) return send(404, { error: `${JSON.stringify(dir)} is not a tree` });
      const entries = new Map<string, unknown>();
      for (const [p, e] of tree) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) entries.set(rest, { name: rest, mode: e.mode, kind: "blob", oid: e.oid, size: null, last_commit: null });
        else {
          const name = rest.slice(0, slash);
          if (!entries.has(name)) entries.set(name, { name, mode: "40000", kind: "tree", oid: treeOidFor(name), size: null, last_commit: null });
        }
      }
      if (dir && entries.size === 0) return send(404, { error: `${JSON.stringify(dir)} not in this layout at ${JSON.stringify(at)}` });
      return send(200, { commit, entries: [...entries.values()] });
    }
    if (m === "POST" && route === "/commits") {
      const hook = this.beforeCommit;
      this.beforeCommit = null;
      const injected = hook?.(body);
      if (injected) return send(injected.status, injected.body);
      const ops: any[] = body.operations ?? [];
      if (ops.length === 0) return send(400, { error: "no operations" });
      if (ops.length > 10_000) return send(400, { error: "too many operations (max 10000)" });
      const branch: string = body.branch ?? "main";
      const current = this.branches.get(branch) ?? null;
      let parent: string | null;
      if (!("expected_parent" in body)) parent = current;
      else if (body.expected_parent === null) {
        if (current) return send(409, { error: "expected_parent does not match the current branch tip", current_tip: current });
        parent = null;
      } else {
        if (current !== body.expected_parent) {
          return send(409, { error: "expected_parent does not match the current branch tip", current_tip: current });
        }
        parent = current;
      }
      const tree: Tree = new Map(parent ? this.commits.get(parent)!.tree : []);
      for (const op of ops) {
        const parts = String(op.path).split("/").filter((p: string) => p.length > 0);
        if (parts.length === 0 || parts.some((p: string) => p === "." || p === ".." || p === ".git" || p.includes("\0"))) {
          return send(400, { error: `invalid path ${JSON.stringify(op.path)}` });
        }
        const path = parts.join("/");
        if (op.op === "put") tree.set(path, { oid: blobOid(new TextEncoder().encode(op.content)), mode: "100644" });
        else if (op.op === "put_base64") {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(op.content)) return send(400, { error: `bad base64 for ${op.path}` });
          tree.set(path, { oid: blobOid(Buffer.from(op.content, "base64")), mode: "100644" });
        } else if (op.op === "delete") tree.delete(path);
        else return send(422, { error: "unknown op" });
      }
      const oid = this.newCommit(tree, parent, body.message);
      this.setBranch(branch, oid);
      return send(201, { commit: oid, tree: treeOidFor(oid), parent, branch });
    }
    if (m === "POST" && route === "/reset") {
      const to = this.resolve(body.to);
      if (!to) return send(404, { error: `unknown rev ${JSON.stringify(body.to)}` });
      const branch: string = body.branch ?? "main";
      const current = this.branches.get(branch) ?? null;
      if (body.expected_head !== undefined && body.expected_head !== current) {
        return send(409, { error: `precondition failed on refs/heads/${branch}`, current });
      }
      this.setBranch(branch, to);
      return send(200, { oid: to });
    }
    if (m === "DELETE" && route.startsWith("/branches/")) {
      this.branches.delete(decodeURIComponent(route.slice("/branches/".length)));
      return send(204);
    }
    if (m === "GET" && route === "/site") {
      const enabled = this.moves.length > 0;
      return send(200, {
        enabled,
        host: enabled ? "site--acme" : null,
        url: enabled && this.sitesDomain ? `https://site--acme.${this.sitesDomain}` : null,
        branch: null,
        config_state: this.siteConfigError ? "refused" : this.siteConfig ? "ok" : "absent",
        config_error: this.siteConfigError,
        config: this.siteConfig && !this.siteConfigError ? { ...this.siteConfig, spa: false, not_found: null } : null,
        current: null,
        deploys: [],
      });
    }
    return send(404, { error: `no route ${m} ${route}` });
  }
}

function treeOidFor(name: string): string {
  return createHash("sha1").update(`tree ${name}`).digest("hex");
}
