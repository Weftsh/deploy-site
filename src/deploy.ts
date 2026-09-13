import { ApiError, type WeftClient } from "./client";
import { chunk, listRemote, planOperations, validateChunking, type SizedOperation } from "./plan";
import { walkDirectory, type LocalFile } from "./walk";

export interface DeployConfig {
  directory: string;
  /** The directory in the Weft tree the files land under; what `publish:` names. */
  path: string;
  branch: string;
  message: string;
  chunkOperations: number;
  chunkBytes: number;
}

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
  notice(msg: string): void;
}

export interface DeployResult {
  /** What `branch` points at when the deploy is done. */
  commit: string;
  /** The site's address, or null when the deployment serves no sites domain. */
  url: string | null;
  /** Files put or deleted. Zero means the branch already held the directory. */
  changed: number;
}

/** A refusal made on purpose, with the sentence the step fails with. */
export class DeployRefusal extends Error {}

export function stagingBranch(branch: string): string {
  return `${branch}-staging`;
}

export async function deploy(cfg: DeployConfig, client: WeftClient, log: Logger): Promise<DeployResult> {
  validatePath(cfg.path);
  validateChunking(cfg.chunkOperations, cfg.chunkBytes);
  const local = await walkDirectory(cfg.directory);
  log.info(`${local.length} files under ${cfg.directory}`);
  const { commit, changed } = await attempt(cfg, client, log, local, 1);
  const url = await report(cfg, client, log);
  return { commit, url, changed };
}

/**
 * The server's own path rule (`split_path` in commits.rs), applied to
 * the prefix before the walk, so a bad `path` input fails by name
 * rather than as a 400 on the first request.
 */
function validatePath(path: string): void {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new DeployRefusal("path must name a directory in the tree; the site config cannot publish the root");
  }
  for (const p of parts) {
    if (p === "." || p === ".." || p === ".git" || p.includes("\0")) {
      throw new DeployRefusal(`path ${path} has a segment the server rejects (${p})`);
    }
  }
}

async function attempt(
  cfg: DeployConfig,
  client: WeftClient,
  log: Logger,
  local: LocalFile[],
  retries: number,
): Promise<{ commit: string; changed: number }> {
  const prefix = cfg.path.split("/").filter((p) => p.length > 0).join("/");
  const branches = await client.branches();
  const tip = branches.find((b) => b.name === cfg.branch)?.oid ?? null;
  const staging = stagingBranch(cfg.branch);
  const stagingExists = branches.some((b) => b.name === staging);

  const remote = tip ? await listRemote(client, prefix, tip) : new Map();
  const ops = planOperations(local, remote, prefix);
  const puts = ops.filter((o) => o.op.op !== "delete").length;
  log.info(
    tip
      ? `${cfg.branch} is at ${tip.slice(0, 12)}: ${puts} to put, ${ops.length - puts} to delete, ${local.length - puts} unchanged`
      : `${cfg.branch} does not exist yet: ${puts} to put`,
  );
  if (ops.length === 0) {
    log.info("nothing to commit; the branch already holds this directory");
    return { commit: tip!, changed: 0 };
  }
  const chunks = chunk(ops, cfg.chunkOperations, cfg.chunkBytes);

  const retry = async (where: string, current: string | null | undefined) => {
    if (retries === 0) {
      throw new DeployRefusal(`${cfg.branch} moved while this deploy was running (${where}); giving up after one retry`);
    }
    log.info(`${cfg.branch} moved to ${current ? current.slice(0, 12) : "nothing"} during ${where}; recomputing once`);
    return attempt(cfg, client, log, local, retries - 1);
  };

  if (chunks.length === 1) {
    try {
      const out = await client.commit({
        branch: cfg.branch,
        expected_parent: tip,
        message: cfg.message,
        operations: chunks[0].map((o) => o.op),
      });
      log.info(`committed ${out.commit} to ${cfg.branch}`);
      return { commit: out.commit, changed: ops.length };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        return retry("the commit", (e.body as { current_tip?: string | null })?.current_tip);
      }
      throw e;
    }
  }

  // Too much for one request. Every chunk goes to a staging branch so
  // the published branch, and the publish job reading it, never sees a
  // half-written tree; the branch moves once, at the end.
  log.info(`${ops.length} operations in ${chunks.length} requests via ${staging}`);
  if (tip) {
    await client.reset(staging, tip);
  } else if (stagingExists) {
    // A leftover from an earlier run, with no tip to rebase it onto.
    await client.deleteBranch(staging);
  }
  let parent: string | null = tip;
  for (const [i, c] of chunks.entries()) {
    let out;
    try {
      out = await client.commit({
        branch: staging,
        expected_parent: parent,
        message: `${cfg.message} (part ${i + 1}/${chunks.length})`,
        operations: c.map((o) => o.op),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        throw new DeployRefusal(`${staging} moved under this deploy; another deploy of ${cfg.branch} is running`);
      }
      throw e;
    }
    log.info(`part ${i + 1}/${chunks.length}: ${c.length} operations, ${out.commit.slice(0, 12)}`);
    parent = out.commit;
  }
  try {
    await client.reset(cfg.branch, parent!, tip ?? undefined);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      return retry("the final reset", (e.body as { current?: string | null })?.current);
    }
    throw e;
  }
  // A reset moves the ref and nothing else: the server arms its site
  // publish job from the commit route, not from a ref move, so a deploy
  // that ended on the reset would sit unpublished until the next push.
  // One more commit on the branch, re-putting the smallest file with
  // the bytes it already has, leaves the tree exactly as it is and goes
  // through the door that publishes.
  const trigger = smallestPut(ops, local, prefix);
  const out = await client.commit({
    branch: cfg.branch,
    expected_parent: parent,
    message: `${cfg.message} (publish)`,
    operations: [trigger],
  });
  log.info(`moved ${cfg.branch} to ${parent!.slice(0, 12)} and published as ${out.commit}`);
  return { commit: out.commit, changed: ops.length };
}

function smallestPut(ops: SizedOperation[], local: LocalFile[], prefix: string) {
  const puts = ops.filter((o) => o.op.op !== "delete");
  if (puts.length > 0) return puts.reduce((a, b) => (b.size < a.size ? b : a)).op;
  // Every operation was a delete; every local file is already in the tree.
  const f = local.reduce((a, b) => (b.bytes.byteLength < a.bytes.byteLength ? b : a));
  return planOperations([f], new Map(), prefix)[0].op;
}

async function report(cfg: DeployConfig, client: WeftClient, log: Logger): Promise<string | null> {
  const site = await client.site();
  const prefix = cfg.path.split("/").filter((p) => p.length > 0).join("/");
  switch (site.config_state) {
    case "absent":
      log.warning(
        `no .weft/site.yml on the default branch, so nothing publishes: commit one with ` +
          `"publish: ${prefix}" and "branch: ${cfg.branch}"`,
      );
      break;
    case "refused":
      log.warning(`.weft/site.yml is refused, so nothing publishes: ${site.config_error}`);
      break;
    case "ok": {
      const c = site.config!;
      if (c.branch !== cfg.branch) {
        log.warning(
          `.weft/site.yml publishes from ${c.branch ?? "the default branch"}, not ${cfg.branch}; ` +
            `set "branch: ${cfg.branch}" for this deploy to be served`,
        );
      }
      if (c.publish !== prefix) {
        log.warning(
          `.weft/site.yml publishes ${c.publish}, but this deploy wrote ${prefix}; ` +
            `set "publish: ${prefix}" or pass path: ${c.publish}`,
        );
      }
      break;
    }
  }
  if (site.url) {
    log.notice(`site: ${site.url}`);
  } else {
    log.notice("this deployment has no public sites domain yet, so the site has no URL");
  }
  return site.url;
}
