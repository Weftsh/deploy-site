import * as core from "@actions/core";
import { ApiError, TransportError, WeftClient } from "./client";
import { deploy, DeployRefusal } from "./deploy";
import { PlanRefusal } from "./plan";
import { WalkRefusal } from "./walk";

function integer(name: string): number {
  const raw = core.getInput(name).trim();
  if (!/^\d+$/.test(raw)) throw new DeployRefusal(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  const repository = core.getInput("repository", { required: true }).trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new DeployRefusal(`repository must be org/repo, got ${JSON.stringify(repository)}`);
  }
  const sha = process.env.GITHUB_SHA ?? "";
  const from = process.env.GITHUB_REPOSITORY ?? "";
  const message =
    core.getInput("message") || `Deploy ${sha.slice(0, 7) || "unknown"} from ${from || "an unknown repository"}`;

  const client = new WeftClient(core.getInput("api-url") || "https://api.weft.sh", token, repository);
  const result = await deploy(
    {
      directory: core.getInput("directory") || "dist",
      path: core.getInput("path") || "dist",
      branch: core.getInput("branch") || "weft-site",
      message,
      chunkOperations: integer("chunk-operations"),
      chunkBytes: integer("chunk-bytes"),
    },
    client,
    { info: core.info, warning: core.warning, notice: core.notice },
  );
  core.setOutput("commit", result.commit);
  core.setOutput("url", result.url ?? "");
  core.setOutput("changed", String(result.changed));
}

run().catch((e: unknown) => {
  const expected =
    e instanceof WalkRefusal ||
    e instanceof PlanRefusal ||
    e instanceof DeployRefusal ||
    e instanceof ApiError ||
    e instanceof TransportError;
  if (!expected && e instanceof Error && e.stack) core.debug(e.stack);
  core.setFailed(e instanceof Error ? e.message : String(e));
});
