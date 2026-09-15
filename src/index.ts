import { CI_TTL, DOWNLOADS_TTL, readCache, writeCache } from "./cache";
import type { CiStatus, Env } from "./env";
import * as curseforge from "./providers/curseforge";
import * as github from "./providers/github";
import * as modrinth from "./providers/modrinth";
import { formatNumber, render, templates } from "./templates";

/** Route parameters are restricted to characters safe for upstream APIs and XML output. */
const PARAM_RE = /^[A-Za-z0-9._-]+$/;

const INDEX_TEXT = `icon.anvilcraft.dev — dynamic SVG badges

Endpoints:
  /modrinth/downloads/:slug            Modrinth downloads badge   (cached 3h)
  /curseforge/downloads/:slug          CurseForge downloads badge (cached 3h)
  /github/downloads/:owner/:repo       GitHub release downloads   (cached 3h)
  /github/ci/:owner/:repo/:workflow    GitHub Actions CI status   (cached 60s)

Example: /github/downloads/Anvil-Dev/AnvilCraft
`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
      return new Response(INDEX_TEXT, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const [provider, kind, ...params] = segments;
    if (!params.every((p) => PARAM_RE.test(p))) {
      return badRequest("Invalid path parameter: only [A-Za-z0-9._-] is allowed.");
    }

    if (kind === "downloads" && provider === "modrinth" && params.length === 1) {
      return downloadsBadge(env, ctx, {
        cacheKey: `modrinth:downloads:${params[0]}`,
        template: templates.modrinthDownloads,
        fetch: () => modrinth.getProjectDownloads(env, params[0]),
      });
    }

    if (kind === "downloads" && provider === "curseforge" && params.length === 1) {
      return downloadsBadge(env, ctx, {
        cacheKey: `curseforge:downloads:${params[0]}`,
        template: templates.curseforgeDownloads,
        fetch: () => curseforge.getProjectDownloads(env, params[0]),
      });
    }

    if (kind === "downloads" && provider === "github" && params.length === 2) {
      const [owner, repo] = params;
      return downloadsBadge(env, ctx, {
        cacheKey: `github:downloads:${owner}/${repo}`,
        template: templates.githubDownloads,
        fetch: () => github.getRepoDownloads(env, owner, repo),
      });
    }

    if (kind === "ci" && provider === "github" && params.length === 3) {
      const [owner, repo, workflow] = params;
      return ciBadge(env, ctx, owner, repo, workflow);
    }

    return badRequest("Unknown endpoint. See / for the list of available badges.");
  },
} satisfies ExportedHandler<Env>;

interface DownloadsBadgeOptions {
  cacheKey: string;
  template: string;
  fetch: () => Promise<number>;
}

/**
 * Render a downloads badge. Values are cached in KV for DOWNLOADS_TTL; on an
 * upstream failure without a cached value we still serve a valid SVG showing
 * "N/A" so badges embedded in READMEs never break.
 */
async function downloadsBadge(
  env: Env,
  ctx: ExecutionContext,
  opts: DownloadsBadgeOptions,
): Promise<Response> {
  let downloads = await readCache<number>(env.ICON_CACHE, opts.cacheKey);

  if (downloads === null) {
    try {
      downloads = await opts.fetch();
      ctx.waitUntil(writeCache(env.ICON_CACHE, opts.cacheKey, downloads, DOWNLOADS_TTL));
    } catch (error) {
      console.error(opts.cacheKey, error);
      return svgResponse(render(opts.template, { downloads: "N/A" }), 0);
    }
  }

  return svgResponse(render(opts.template, { downloads: formatNumber(downloads) }), DOWNLOADS_TTL);
}

/** Render a GitHub Actions CI badge, cached for CI_TTL. */
async function ciBadge(
  env: Env,
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  workflow: string,
): Promise<Response> {
  const cacheKey = `github:ci:${owner}/${repo}/${workflow}`;
  let status = await readCache<CiStatus>(env.ICON_CACHE, cacheKey);

  if (status === null) {
    try {
      status = await github.getWorkflowStatus(env, owner, repo, workflow);
      ctx.waitUntil(writeCache(env.ICON_CACHE, cacheKey, status, CI_TTL));
    } catch (error) {
      console.error(cacheKey, error);
      status = { name: workflow, status: "unknown", color: "#9F9F9F" };
      return svgResponse(
        render(templates.githubCi, {
          Name: status.name,
          Status: status.status,
          status_color: status.color,
        }),
        0,
      );
    }
  }

  return svgResponse(
    render(templates.githubCi, {
      Name: status.name,
      Status: status.status,
      status_color: status.color,
    }),
    CI_TTL,
  );
}

function svgResponse(svg: string, maxAge: number): Response {
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-cache",
    },
  });
}

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
