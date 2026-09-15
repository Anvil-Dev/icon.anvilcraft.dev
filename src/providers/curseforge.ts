import type { CfWidgetProject, CurseForgeSearch, Env } from "../env";

/** Error thrown when the CurseForge data source does not answer with usable data. */
export class CurseForgeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurseForgeApiError";
  }
}

/**
 * Fetch the total download counter of a CurseForge project by slug.
 *
 * When a `CURSEFORGE_API_KEY` secret is configured, the official CurseForge
 * API is used; otherwise we fall back to the free cfwidget JSON API, which
 * requires no key.
 */
export async function getProjectDownloads(env: Env, slug: string): Promise<number> {
  return env.CURSEFORGE_API_KEY ? officialDownloads(env.CURSEFORGE_API_KEY, slug) : cfwidgetDownloads(slug);
}

async function cfwidgetDownloads(slug: string): Promise<number> {
  const res = await fetch(
    `https://api.cfwidget.com/minecraft/mc-mods/${encodeURIComponent(slug)}`,
    { headers: { "User-Agent": "icon.anvilcraft.dev" } },
  );
  if (!res.ok) {
    // 202 means the project is being queued for processing; the next request
    // (this response is served with no-cache) will usually find fresh data.
    throw new CurseForgeApiError(`cfwidget responded with HTTP ${res.status} for ${slug}`);
  }
  const data = (await res.json()) as CfWidgetProject;
  if (typeof data.downloads?.total !== "number") {
    throw new CurseForgeApiError(`cfwidget returned no download counter for ${slug}`);
  }
  return data.downloads.total;
}

async function officialDownloads(apiKey: string, slug: string): Promise<number> {
  const url = `https://api.curseforge.com/v1/mods/search?gameId=432&slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, "User-Agent": "icon.anvilcraft.dev" },
  });
  if (!res.ok) {
    throw new CurseForgeApiError(`CurseForge API responded with HTTP ${res.status} for ${slug}`);
  }
  const data = (await res.json()) as CurseForgeSearch;
  const mod = data.data?.find((m) => m.slug === slug) ?? data.data?.[0];
  if (typeof mod?.downloadCount !== "number") {
    throw new CurseForgeApiError(`CurseForge API returned no download counter for ${slug}`);
  }
  return mod.downloadCount;
}
