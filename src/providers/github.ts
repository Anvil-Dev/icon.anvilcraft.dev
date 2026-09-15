import type { CiStatus, Env, GitHubRelease, GitHubWorkflow, GitHubWorkflowRuns } from "../env";

const API_BASE = "https://api.github.com";
const MAX_RELEASE_PAGES = 10;

/** Error thrown when the GitHub API does not answer with a 2xx response. */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    path: string,
  ) {
    super(`GitHub API ${path} responded with HTTP ${status}`);
    this.name = "GitHubApiError";
  }
}

/**
 * Fetch the GitHub REST API. When an OAuth App's client credentials are
 * configured as secrets, they are sent via HTTP Basic auth, granting a
 * dedicated 5000 requests/hour quota for public data. Otherwise the request
 * is unauthenticated (60 requests/hour, shared IP), which KV caching absorbs.
 */
async function githubFetch<T>(env: Env, path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "icon.anvilcraft.dev",
  };
  if (env.GH_CLIENT_ID && env.GH_CLIENT_SECRET) {
    headers.Authorization = `Basic ${btoa(`${env.GH_CLIENT_ID}:${env.GH_CLIENT_SECRET}`)}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    throw new GitHubApiError(res.status, path);
  }
  return (await res.json()) as T;
}

/** Sum the asset download counters of every release of a repository. */
export async function getRepoDownloads(env: Env, owner: string, repo: string): Promise<number> {
  let total = 0;
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const releases = await githubFetch<GitHubRelease[]>(
      env,
      `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
    );
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        total += asset.download_count ?? 0;
      }
    }
    if (releases.length < 100) break;
  }
  return total;
}

const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const COLOR_PASSING = "#34D058";
const COLOR_FAILING = "#F85149";
const COLOR_RUNNING = "#D29922";
const COLOR_UNKNOWN = "#9F9F9F";

/** Fetch the status of the latest run of a workflow (e.g. "ci.yml"). */
export async function getWorkflowStatus(
  env: Env,
  owner: string,
  repo: string,
  workflow: string,
): Promise<CiStatus> {
  const data = await githubFetch<GitHubWorkflowRuns>(
    env,
    `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
  );
  const run = data.workflow_runs?.[0];
  // Prefer the display name configured via `name:` in the workflow YAML;
  // every run carries it, so no extra request is needed in the common case.
  const name = run?.name?.trim() || (await getWorkflowName(env, owner, repo, workflow));
  if (!run) {
    return { name, status: "unknown", color: COLOR_UNKNOWN };
  }
  if (run.conclusion === "success") {
    return { name, status: "passing", color: COLOR_PASSING };
  }
  if (run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion)) {
    return { name, status: "failing", color: COLOR_FAILING };
  }
  // No conclusion yet: queued / in_progress / waiting / pending ...
  return { name, status: "running", color: COLOR_RUNNING };
}

/**
 * Fetch the display name of a workflow that has no runs yet.
 * Falls back to the workflow file name when the lookup fails.
 */
async function getWorkflowName(
  env: Env,
  owner: string,
  repo: string,
  workflow: string,
): Promise<string> {
  try {
    const data = await githubFetch<GitHubWorkflow>(
      env,
      `/repos/${owner}/${repo}/actions/workflows/${workflow}`,
    );
    return data.name?.trim() || workflow;
  } catch {
    return workflow;
  }
}
