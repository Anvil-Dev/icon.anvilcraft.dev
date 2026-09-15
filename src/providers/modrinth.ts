import type { Env, ModrinthProject } from "../env";

const API_BASE = "https://api.modrinth.com/v2";

/** Error thrown when the Modrinth API does not answer with a 2xx response. */
export class ModrinthApiError extends Error {
  constructor(
    public readonly status: number,
    slug: string,
  ) {
    super(`Modrinth API project ${slug} responded with HTTP ${status}`);
    this.name = "ModrinthApiError";
  }
}

/** Fetch the total download counter of a Modrinth project by slug or id. */
export async function getProjectDownloads(_env: Env, slug: string): Promise<number> {
  const res = await fetch(`${API_BASE}/project/${encodeURIComponent(slug)}`, {
    headers: { "User-Agent": "icon.anvilcraft.dev (https://icon.anvilcraft.dev)" },
  });
  if (!res.ok) {
    throw new ModrinthApiError(res.status, slug);
  }
  const project = (await res.json()) as ModrinthProject;
  if (typeof project.downloads !== "number") {
    throw new ModrinthApiError(502, slug);
  }
  return project.downloads;
}
