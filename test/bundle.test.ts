/**
 * The runner does not import `src/`; it runs `dist/index.js` on Node 20
 * with `INPUT_*` in the environment and reads outputs from the file
 * `GITHUB_OUTPUT` names. This drives exactly that, against the fake, so
 * the input parsing in main.ts and the bundle itself are covered by
 * something other than the CI job that only checks `dist` is fresh.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWeft } from "./fake";

let fake: FakeWeft;
let dir: string;

beforeEach(async () => {
  fake = new FakeWeft();
  await fake.start();
  dir = await mkdtemp(join(tmpdir(), "weft-bundle-"));
});

afterEach(async () => {
  await fake.stop();
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  outputs: Record<string, string>;
}

async function runAction(inputs: Record<string, string>, extraEnv: Record<string, string> = {}): Promise<Run> {
  const outFile = join(dir, "github-output");
  await writeFile(outFile, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_OUTPUT: outFile,
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_REPOSITORY: "acme/widget",
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = v;
  const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js")], { env, cwd: dir });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const outputs: Record<string, string> = {};
  const raw = await readFile(outFile, "utf8");
  // core.setOutput writes `name<<delim\nvalue\ndelim`.
  for (const m of raw.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  return { code, stdout, outputs };
}

describe("dist/index.js", () => {
  it("deploys with the documented defaults and writes the outputs", async () => {
    await mkdir(join(dir, "dist/css"), { recursive: true });
    await writeFile(join(dir, "dist/index.html"), "<h1>built</h1>");
    await writeFile(join(dir, "dist/css/site.css"), "body{}");
    const run = await runAction({
      token: fake.token,
      repository: `${fake.org}/${fake.repo}`,
      "api-url": fake.url,
      "chunk-operations": "5000",
      "chunk-bytes": "33554432",
    });
    expect(run.code, run.stdout).toBe(0);
    expect(run.outputs.changed).toBe("2");
    expect(run.outputs.commit).toBe(fake.branches.get("weft-site"));
    expect(run.outputs.url).toBe("https://site--acme.sites.example");
    expect([...fake.filesUnder("weft-site", "dist").keys()].sort()).toEqual(["css/site.css", "index.html"]);
    const commit = fake.requests.find((r) => r.method === "POST" && r.url.endsWith("/commits"))!.body as any;
    expect(commit.message).toBe("Deploy 0123456 from acme/widget");
    // The token is registered for masking, once, and appears nowhere else.
    const lines = run.stdout.split("\n");
    expect(lines.filter((l) => l.startsWith("::add-mask::"))).toEqual([`::add-mask::${fake.token}`]);
    expect(lines.filter((l) => !l.startsWith("::add-mask::")).join("\n")).not.toContain("secret");
    expect(run.stdout).toContain("::notice::site: https://site--acme.sites.example");
  });

  it("fails the step by name on a refusal, before any request", async () => {
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out/run.sh"), "#!/bin/sh", { mode: 0o755 });
    const run = await runAction({
      token: fake.token,
      repository: `${fake.org}/${fake.repo}`,
      "api-url": fake.url,
      directory: "out",
      "chunk-operations": "5000",
      "chunk-bytes": "33554432",
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("::error::run.sh is executable");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a repository that is not org/repo and a chunk size that is not a number", async () => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist/index.html"), "x");
    let run = await runAction({
      token: fake.token,
      repository: "acme",
      "api-url": fake.url,
      "chunk-operations": "5000",
      "chunk-bytes": "33554432",
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("::error::repository must be org/repo");
    run = await runAction({
      token: fake.token,
      repository: `${fake.org}/${fake.repo}`,
      "api-url": fake.url,
      "chunk-operations": "5000",
      "chunk-bytes": "32 MB",
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("::error::chunk-bytes must be a whole number");
    expect(fake.requests).toHaveLength(0);
  });
});
