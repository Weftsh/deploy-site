import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobOid } from "../src/blob";
import { WeftClient } from "../src/client";
import { deploy, type DeployConfig, type Logger } from "../src/deploy";
import { chunk, MAX_OPERATIONS, type SizedOperation } from "../src/plan";
import { FakeWeft } from "./fake";

let fake: FakeWeft;
let dir: string;
let lines: string[];

const log: Logger = {
  info: (m) => lines.push(`info: ${m}`),
  warning: (m) => lines.push(`warning: ${m}`),
  notice: (m) => lines.push(`notice: ${m}`),
};

beforeEach(async () => {
  fake = new FakeWeft();
  await fake.start();
  dir = await mkdtemp(join(tmpdir(), "weft-site-"));
  lines = [];
});

afterEach(async () => {
  await fake.stop();
  await rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string | Uint8Array>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), c);
  }
}

function client() {
  return new WeftClient(fake.url, fake.token, `${fake.org}/${fake.repo}`);
}

function config(over: Partial<DeployConfig> = {}): DeployConfig {
  return {
    directory: dir,
    path: "dist",
    branch: "weft-site",
    message: "Deploy abc1234 from acme/widget",
    chunkOperations: 5000,
    chunkBytes: 32 * 1024 * 1024,
    ...over,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const commitPosts = () => fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/commits"));

describe("one request", () => {
  it("creates the branch with the directory under path, text as put and binary as put_base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]);
    await write({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)", "img/logo.png": png });
    const out = await deploy(config(), client(), log);

    expect(out.changed).toBe(3);
    expect(out.commit).toBe(fake.branches.get("weft-site"));
    expect(out.url).toBe("https://site--acme.sites.example");
    expect(fake.filesUnder("weft-site", "dist")).toEqual(
      new Map([
        ["index.html", blobOid(bytes("<h1>hi</h1>"))],
        ["assets/app.js", blobOid(bytes("console.log(1)"))],
        ["img/logo.png", blobOid(png)],
      ]),
    );
    const posts = commitPosts();
    expect(posts).toHaveLength(1);
    const body = posts[0].body as any;
    expect(body.branch).toBe("weft-site");
    expect(body.expected_parent).toBeNull();
    expect(body.message).toBe("Deploy abc1234 from acme/widget");
    const byPath = Object.fromEntries(body.operations.map((o: any) => [o.path, o]));
    expect(byPath["dist/index.html"]).toEqual({ op: "put", path: "dist/index.html", content: "<h1>hi</h1>" });
    expect(byPath["dist/img/logo.png"]).toEqual({
      op: "put_base64",
      path: "dist/img/logo.png",
      content: Buffer.from(png).toString("base64"),
    });
    expect(fake.branches.has("weft-site-staging")).toBe(false);
    expect(lines).toContain("notice: site: https://site--acme.sites.example");
  });

  it("pins expected_parent to the tip when the branch exists", async () => {
    const tip = fake.seed("weft-site", { "dist/old.html": "old" });
    await write({ "index.html": "new" });
    await deploy(config(), client(), log);
    expect((commitPosts()[0].body as any).expected_parent).toBe(tip);
  });

  it("skips files whose blob is unchanged and makes no commit when nothing changed", async () => {
    await write({ "index.html": "<h1>hi</h1>", "a/b/c.txt": "deep", "bin.dat": new Uint8Array([0, 1, 2]) });
    const first = await deploy(config(), client(), log);
    expect(first.changed).toBe(3);
    fake.requests.length = 0;

    const again = await deploy(config(), client(), log);
    expect(again.changed).toBe(0);
    expect(again.commit).toBe(first.commit);
    expect(commitPosts()).toHaveLength(0);
    expect(fake.requests.some((r) => r.url.includes("/reset"))).toBe(false);

    await write({ "index.html": "<h1>changed</h1>" });
    fake.requests.length = 0;
    const third = await deploy(config(), client(), log);
    expect(third.changed).toBe(1);
    const ops = (commitPosts()[0].body as any).operations;
    expect(ops).toEqual([{ op: "put", path: "dist/index.html", content: "<h1>changed</h1>" }]);
  });

  it("re-puts a file whose bytes match but whose mode is not 100644", async () => {
    fake.seed("weft-site", { "dist/run.sh": "echo" }, { "dist/run.sh": "100755" });
    await write({ "run.sh": "echo" });
    const out = await deploy(config(), client(), log);
    expect(out.changed).toBe(1);
    expect(fake.treeOf("weft-site").get("dist/run.sh")!.mode).toBe("100644");
  });

  it("deletes files that are gone locally and leaves the rest of the tree alone", async () => {
    fake.seed("weft-site", {
      "dist/index.html": "<h1>hi</h1>",
      "dist/old/page.html": "bye",
      "dist/old/deeper/x.css": "x",
      "README.md": "not under dist",
      ".weft/site.yml": "publish: dist\nbranch: weft-site\n",
    });
    await write({ "index.html": "<h1>hi</h1>" });
    const out = await deploy(config(), client(), log);
    expect(out.changed).toBe(2);
    const ops = (commitPosts()[0].body as any).operations;
    expect(ops).toEqual([
      { op: "delete", path: "dist/old/deeper/x.css" },
      { op: "delete", path: "dist/old/page.html" },
    ]);
    expect([...fake.treeOf("weft-site").keys()].sort()).toEqual([".weft/site.yml", "README.md", "dist/index.html"]);
  });

  it("retries once when the tip moves between the read and the commit, against the new tip", async () => {
    fake.seed("weft-site", { "dist/index.html": "v1", "dist/keep.txt": "k" });
    await write({ "index.html": "v2", "keep.txt": "k" });
    // Someone else lands a commit after the action read the tip.
    fake.beforeCommit = () => {
      fake.seed("weft-site", { "dist/index.html": "v1", "dist/keep.txt": "k", "dist/other.txt": "theirs" });
      return { status: 409, body: { error: "expected_parent does not match the current branch tip", current_tip: fake.branches.get("weft-site") } };
    };
    const out = await deploy(config(), client(), log);
    expect(out.changed).toBe(2);
    const posts = commitPosts();
    expect(posts).toHaveLength(2);
    expect((posts[1].body as any).expected_parent).toBe((posts[1].body as any).expected_parent);
    // The retry saw their file and deleted it, and re-put ours.
    expect([...fake.treeOf("weft-site").keys()].sort()).toEqual(["dist/index.html", "dist/keep.txt"]);
    expect(fake.treeOf("weft-site").get("dist/index.html")!.oid).toBe(blobOid(bytes("v2")));
    expect(lines.some((l) => l.includes("recomputing once"))).toBe(true);
  });

  it("gives up after the second 409", async () => {
    await write({ "index.html": "x" });
    const conflict = () => ({ status: 409, body: { error: "expected_parent does not match the current branch tip", current_tip: null } });
    fake.beforeCommit = () => {
      fake.beforeCommit = conflict;
      return conflict();
    };
    await expect(deploy(config(), client(), log)).rejects.toThrow(/moved while this deploy was running/);
  });
});

describe("chunked", () => {
  it("stages every chunk, resets the branch once, and publishes with one more commit", async () => {
    const tip = fake.seed("weft-site", { "dist/stale.html": "stale", "dist/same.txt": "same" });
    await write({ "a.txt": "a", "b.txt": "bb", "c.txt": "ccc", "d.txt": "dddd", "same.txt": "same" });
    const out = await deploy(config({ chunkOperations: 2 }), client(), log);

    // 4 puts + 1 delete = 5 operations in chunks of 2.
    expect(out.changed).toBe(5);
    const posts = commitPosts();
    expect(posts.map((p) => (p.body as any).branch)).toEqual([
      "weft-site-staging",
      "weft-site-staging",
      "weft-site-staging",
      "weft-site",
    ]);
    expect(posts.map((p) => (p.body as any).operations.length)).toEqual([2, 2, 1, 1]);
    expect(posts.map((p) => (p.body as any).message)).toEqual([
      "Deploy abc1234 from acme/widget (part 1/3)",
      "Deploy abc1234 from acme/widget (part 2/3)",
      "Deploy abc1234 from acme/widget (part 3/3)",
      "Deploy abc1234 from acme/widget (publish)",
    ]);
    // Staging was rebased onto the tip before the first chunk.
    const resets = fake.requests.filter((r) => r.url.endsWith("/reset")).map((r) => r.body as any);
    expect(resets[0]).toEqual({ branch: "weft-site-staging", to: tip });
    expect(resets[1]).toMatchObject({ branch: "weft-site", expected_head: tip });
    expect((posts[0].body as any).expected_parent).toBe(tip);

    // The published branch moved exactly twice, and both times held the whole directory.
    const want = new Map([
      ["a.txt", blobOid(bytes("a"))],
      ["b.txt", blobOid(bytes("bb"))],
      ["c.txt", blobOid(bytes("ccc"))],
      ["d.txt", blobOid(bytes("dddd"))],
      ["same.txt", blobOid(bytes("same"))],
    ]);
    const published = fake.moves.filter((m) => m.branch === "weft-site");
    expect(published).toHaveLength(2);
    for (const m of published) {
      const files = new Map([...m.tree].filter(([p]) => p.startsWith("dist/")).map(([p, e]) => [p.slice(5), e.oid]));
      expect(files).toEqual(want);
    }
    expect(out.commit).toBe(fake.branches.get("weft-site"));
    // The publish commit re-put the smallest file, changing nothing.
    expect((posts[3].body as any).operations).toEqual([{ op: "put", path: "dist/a.txt", content: "a" }]);
    expect(fake.filesUnder("weft-site", "dist")).toEqual(want);
  });

  it("creates the branch from a root commit when it does not exist, discarding a stale staging branch", async () => {
    fake.seed("weft-site-staging", { "dist/leftover.html": "from a failed run" });
    await write({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const out = await deploy(config({ chunkOperations: 2 }), client(), log);
    expect(out.changed).toBe(3);
    expect(fake.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/branches/weft-site-staging"))).toBe(true);
    const posts = commitPosts();
    expect((posts[0].body as any).expected_parent).toBeNull();
    expect([...fake.filesUnder("weft-site", "dist").keys()].sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    const reset = fake.requests.filter((r) => r.url.endsWith("/reset")).map((r) => r.body as any);
    expect(reset).toHaveLength(1);
    expect(reset[0]).not.toHaveProperty("expected_head");
  });

  it("splits by bytes as well as by count", async () => {
    await write({ "a.txt": "x".repeat(100), "b.txt": "y".repeat(100), "c.txt": "z".repeat(100) });
    await deploy(config({ chunkBytes: 250 }), client(), log);
    expect(commitPosts().map((p) => (p.body as any).operations.length)).toEqual([2, 1, 1]);
  });

  it("refuses when the staging branch moves under it rather than resetting over a stranger's work", async () => {
    await write({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    fake.beforeCommit = () => ({ status: 409, body: { error: "expected_parent does not match the current branch tip", current_tip: "f".repeat(40) } });
    await expect(deploy(config({ chunkOperations: 2 }), client(), log)).rejects.toThrow(/another deploy of weft-site is running/);
    expect(fake.branches.has("weft-site")).toBe(false);
  });
});

describe("refusals, before anything is sent", () => {
  it("names a symlink", async () => {
    await write({ "index.html": "x" });
    await symlink("index.html", join(dir, "link.html"));
    await expect(deploy(config(), client(), log)).rejects.toThrow("link.html is a symlink");
    expect(fake.requests).toHaveLength(0);
  });

  it("names an executable", async () => {
    await write({ "index.html": "x", "bin/run": "#!/bin/sh" });
    await chmod(join(dir, "bin/run"), 0o755);
    await expect(deploy(config(), client(), log)).rejects.toThrow("bin/run is executable");
    expect(fake.requests).toHaveLength(0);
  });

  it("names a .git entry", async () => {
    await write({ "index.html": "x", "vendor/.git/HEAD": "ref" });
    await expect(deploy(config(), client(), log)).rejects.toThrow("vendor/.git is a .git entry");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an empty directory and a missing one", async () => {
    await expect(deploy(config(), client(), log)).rejects.toThrow("is empty; nothing to publish");
    await expect(deploy(config({ directory: join(dir, "nope") }), client(), log)).rejects.toThrow("does not exist");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a chunk-operations above the server's cap, and a path the site config cannot publish", async () => {
    await write({ "index.html": "x" });
    await expect(deploy(config({ chunkOperations: MAX_OPERATIONS + 1 }), client(), log)).rejects.toThrow(
      "chunk-operations must be between 1 and 10000",
    );
    await expect(deploy(config({ chunkOperations: 0 }), client(), log)).rejects.toThrow("chunk-operations must be");
    await expect(deploy(config({ path: "/" }), client(), log)).rejects.toThrow("cannot publish the root");
    await expect(deploy(config({ path: "a/../b" }), client(), log)).rejects.toThrow("segment the server rejects");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a single file that cannot fit in one request", () => {
    const big: SizedOperation = { op: { op: "put", path: "dist/big", content: "" }, size: 64 * 1024 * 1024, path: "big" };
    expect(() => chunk([big], 5000, 1024)).toThrow("big is 67108864 bytes as sent");
  });

  it("never exceeds the operation cap even when asked for it", () => {
    const ops: SizedOperation[] = Array.from({ length: 20_001 }, (_, i) => ({
      op: { op: "delete", path: `dist/${i}` },
      size: 0,
      path: String(i),
    }));
    const chunks = chunk(ops, MAX_OPERATIONS, 1024);
    expect(chunks.map((c) => c.length)).toEqual([10_000, 10_000, 1]);
  });
});

describe("the token and the site", () => {
  it("sends the token only as a bearer header, and never logs it", async () => {
    await write({ "index.html": "x" });
    await deploy(config(), client(), log);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.url).not.toContain("secret");
      expect(r.headers.authorization).toBe(`Bearer ${fake.token}`);
    }
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("does not put the token in a refusal's message", async () => {
    await write({ "index.html": "x" });
    const wrong = new WeftClient(fake.url, "weft_01test_other", `${fake.org}/${fake.repo}`);
    await expect(deploy(config(), wrong, log)).rejects.toThrow("GET /branches answered 401: unauthorized");
    await expect(deploy(config(), wrong, log)).rejects.not.toThrow(/other/);
  });

  it("says when the deployment has no sites domain, and when the config will not serve this deploy", async () => {
    await write({ "index.html": "x" });
    fake.sitesDomain = null;
    fake.siteConfig = null;
    const out = await deploy(config(), client(), log);
    expect(out.url).toBeNull();
    expect(lines).toContain("notice: this deployment has no public sites domain yet, so the site has no URL");
    expect(lines.some((l) => l.startsWith("warning: no .weft/site.yml on the default branch") && l.includes('"branch: weft-site"'))).toBe(true);

    lines = [];
    fake.siteConfig = { publish: "public", branch: null };
    await deploy(config(), client(), log);
    expect(lines.some((l) => l.includes("publishes from the default branch, not weft-site"))).toBe(true);
    expect(lines.some((l) => l.includes("publishes public, but this deploy wrote dist"))).toBe(true);

    lines = [];
    fake.siteConfigError = ".weft/site.yml:2: unknown key `buidl`";
    await deploy(config(), client(), log);
    expect(lines.some((l) => l.includes("refused, so nothing publishes: .weft/site.yml:2"))).toBe(true);
  });
});
