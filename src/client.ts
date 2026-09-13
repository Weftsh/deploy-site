/**
 * The four routes this action uses, as the server defines them
 * (`crates/stratum-server/src/api/{commits,refops_api,reads,sites_api}.rs`).
 *
 * The token travels as an Authorization header on every request and
 * nowhere else: never in a URL, never in a log line, never in an error.
 */

export type Operation =
  | { op: "put"; path: string; content: string }
  | { op: "put_base64"; path: string; content: string }
  | { op: "delete"; path: string };

export interface CommitBody {
  branch: string;
  /** Omitted: on top of whatever the branch is now. `null`: the branch must not exist. */
  expected_parent?: string | null;
  message: string;
  operations: Operation[];
}

export interface CommitOut {
  commit: string;
  tree: string;
  parent: string | null;
  branch: string;
}

export interface TreeEntry {
  name: string;
  mode: string;
  kind: "tree" | "blob";
  oid: string;
}

export interface Branch {
  name: string;
  oid: string;
  default: boolean;
}

export interface Site {
  enabled: boolean;
  url: string | null;
  config_state: "absent" | "refused" | "ok";
  config_error: string | null;
  config: { publish: string; branch: string | null } | null;
}

/** The server answered, and the answer was a refusal. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly route: string,
    public readonly body: unknown,
  ) {
    super(`${method} ${route} answered ${status}: ${describe(body)}`);
  }
}

function describe(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class WeftClient {
  private readonly base: string;

  constructor(
    apiUrl: string,
    private readonly token: string,
    repository: string,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {
    const [org, repo] = repository.split("/");
    this.base = `${apiUrl.replace(/\/+$/, "")}/v1/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}`;
  }

  async branches(): Promise<Branch[]> {
    const out = (await this.call("GET", "/branches")) as { branches: Branch[] };
    return out.branches;
  }

  /**
   * One directory's entries at `at`, or null when the path is not a
   * tree there (the server answers 404 for an absent path, an unknown
   * rev, and a path that is a file).
   */
  async tree(path: string, at: string): Promise<TreeEntry[] | null> {
    const route = path ? `/tree/${encodePath(path)}` : "/tree";
    try {
      const out = (await this.call("GET", `${route}?at=${encodeURIComponent(at)}`)) as {
        entries: TreeEntry[];
      };
      return out.entries;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async commit(body: CommitBody): Promise<CommitOut> {
    return (await this.call("POST", "/commits", body)) as CommitOut;
  }

  /** Move `branch` to `to`, creating it when it does not exist. */
  async reset(branch: string, to: string, expectedHead?: string): Promise<string> {
    const body: Record<string, string> = { branch, to };
    if (expectedHead !== undefined) body.expected_head = expectedHead;
    const out = (await this.call("POST", "/reset", body)) as { oid: string };
    return out.oid;
  }

  async deleteBranch(name: string): Promise<void> {
    await this.call("DELETE", `/branches/${encodeURIComponent(name)}`);
  }

  async site(): Promise<Site> {
    return (await this.call("GET", "/site")) as Site;
  }

  private async call(method: string, route: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.base}${route}`, init);
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a non-JSON body is reported as text */
      }
    }
    if (!res.ok) throw new ApiError(res.status, method, route, parsed);
    return parsed;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
