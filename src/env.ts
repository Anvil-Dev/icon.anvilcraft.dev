/** Worker environment: the KV binding plus optional secrets configured via `wrangler secret`. */
export interface Env {
  ICON_CACHE: KVNamespace;
  /** Optional GitHub OAuth App credentials for a dedicated 5000 req/h rate limit on public data. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Optional CurseForge API key. Falls back to the free cfwidget API when absent. */
  CURSEFORGE_API_KEY?: string;
}

/** Minimal shape of a Modrinth project response (only the fields we use). */
export interface ModrinthProject {
  downloads?: number;
}

/** Minimal shape of a GitHub release (only the fields we use). */
export interface GitHubRelease {
  assets?: Array<{ download_count?: number }>;
}

/** Minimal shape of the GitHub workflow-runs response (only the fields we use). */
export interface GitHubWorkflowRuns {
  workflow_runs?: Array<{
    status?: string | null;
    conclusion?: string | null;
  }>;
}

/** Minimal shape of the cfwidget mc-mods JSON response. */
export interface CfWidgetProject {
  downloads?: { total?: number };
}

/** Minimal shape of the official CurseForge mod-search response. */
export interface CurseForgeSearch {
  data?: Array<{ slug?: string; downloadCount?: number }>;
}

/** Result of the GitHub CI endpoint, ready for template substitution. */
export interface CiStatus {
  name: string;
  status: string;
  color: string;
}
