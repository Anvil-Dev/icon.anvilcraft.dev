import { CI_TTL, DOWNLOADS_TTL, readCache, writeCache } from "./cache";
import type { CiStatus, Env } from "./env";
import * as curseforge from "./providers/curseforge";
import * as github from "./providers/github";
import * as modrinth from "./providers/modrinth";
import { formatNumber, measureTextWidth, render, templates, templateWidth, withWidth } from "./templates";

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
      return svgResponse(renderCi({ name: workflow, status: "unknown", color: "#9F9F9F" }), 0);
    }
  }

  return svgResponse(renderCi(status), CI_TTL);
}

/** X offset of the text block inside the CI template, and the right padding. */
const CI_TEXT_LEFT = 60;
const CI_PADDING_RIGHT = 16;

/**
 * Render the CI badge, widening the card when the workflow display name (or
 * the status text) would overflow the template's default width.
 */
function renderCi(status: CiStatus): string {
  const titleWidth = measureTextWidth(status.name, 16, 500);
  const statusWidth = measureTextWidth(status.status, 17, 800);
  const needed = Math.ceil(CI_TEXT_LEFT + Math.max(titleWidth, statusWidth) + CI_PADDING_RIGHT);
  const base = templateWidth(templates.githubCi) ?? needed;
  const template = withWidth(templates.githubCi, Math.max(base, needed));
  return render(template, {
    Name: status.name,
    Status: status.status,
    status_color: status.color,
  });
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
