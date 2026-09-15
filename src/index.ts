import { CI_TTL, DOWNLOADS_TTL, readCache, writeCache } from "./cache";
import type { CiStatus, Env } from "./env";
import * as curseforge from "./providers/curseforge";
import * as github from "./providers/github";
import * as modrinth from "./providers/modrinth";
import { getIcon, UnknownIconError } from "./providers/simpleicons";
import { escapeXml, formatNumber, measureTextWidth, render, templates, templateWidth, withWidth } from "./templates";

/** Route parameters are restricted to characters safe for upstream APIs and XML output. */
const PARAM_RE = /^[A-Za-z0-9._-]+$/;

const INDEX_TEXT = `icon.anvilcraft.dev — dynamic SVG badges

Endpoints:
  /modrinth/downloads/:slug            Modrinth downloads badge   (cached 3h)
  /curseforge/downloads/:slug          CurseForge downloads badge (cached 3h)
  /github/downloads/:owner/:repo       GitHub release downloads   (cached 3h)
  /github/workflow/:owner/:repo/:workflow    GitHub Actions CI status   (cached 60s)
  /custom?title=..&subtitle=..&icon=.....    Fully customizable badge   (cached 24h)

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

    if (provider === "custom" && kind === undefined) {
      return customBadge(env, ctx, new URL(request.url).searchParams);
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

    if (kind === "workflow" && provider === "github" && params.length === 3) {
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
  const cacheKey = `github:workflow:${owner}/${repo}/${workflow}`;
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

/** Custom badges are immutable per URL, so they may be cached for a long time. */
const CUSTOM_TTL = 24 * 60 * 60;

const CUSTOM_DEFAULTS = {
  titleColor: "E8E8E8",
  subtitleColor: "FFFFFF",
  startColor: "202020",
  endColor: "000000",
} as const;

const MAX_TEXT_LENGTH = 64;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const COLOR_RE = /^#?([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;
const ICON_SLUG_RE = /^[a-z0-9]+$/;

/** Thrown for malformed query parameters; mapped to a 400 response. */
class InvalidParamError extends Error {}

/**
 * Render a fully customizable badge driven by query parameters:
 * title/subtitle text and colors, gradient background, and an optional
 * simple-icons glyph (defaulting to its brand color).
 */
async function customBadge(
  env: Env,
  ctx: ExecutionContext,
  query: URLSearchParams,
): Promise<Response> {
  try {
    const title = cleanText(query.get("title"), "title", true);
    const subtitle = cleanText(query.get("subtitle"), "subtitle", false);
    const titleColor = cleanColor(query.get("titleColor")) ?? CUSTOM_DEFAULTS.titleColor;
    const subtitleColor = cleanColor(query.get("subtitleColor")) ?? CUSTOM_DEFAULTS.subtitleColor;
    const startColor = cleanColor(query.get("startColor")) ?? CUSTOM_DEFAULTS.startColor;
    const endColor = cleanColor(query.get("endColor")) ?? CUSTOM_DEFAULTS.endColor;

    const iconSlug = query.get("icon");
    if (iconSlug !== null && !ICON_SLUG_RE.test(iconSlug)) {
      throw new InvalidParamError(`Invalid icon slug: ${iconSlug}`);
    }

    let iconGroup = "";
    let iconColor = cleanColor(query.get("iconColor"));
    if (iconSlug !== null) {
      try {
        const icon = await getIcon(env, ctx, iconSlug);
        iconColor ??= icon.brandColor;
        iconGroup =
          `<g clip-path="url(#clip0_custom)">` +
          `<path d="${icon.path}" fill="#${iconColor}" transform="translate(12 8) scale(1.6666667)"/>` +
          `</g>`;
      } catch (error) {
        if (error instanceof UnknownIconError) throw new InvalidParamError(error.message);
        // Transient CDN failure: degrade to an icon-less badge served with no-cache.
        console.error(`custom:icon:${iconSlug}`, error);
        return svgResponse(
          renderCustom({ title, subtitle, titleColor, subtitleColor, startColor, endColor, iconColor: "FFFFFF", iconGroup: "" }),
          0,
        );
      }
    }

    const svg = renderCustom({
      title,
      subtitle,
      titleColor,
      subtitleColor,
      startColor,
      endColor,
      iconColor: iconColor ?? "FFFFFF",
      iconGroup,
    });
    return svgResponse(svg, CUSTOM_TTL);
  } catch (error) {
    if (error instanceof InvalidParamError) return badRequest(error.message);
    throw error;
  }
}

/** Validate a title/subtitle parameter. */
function cleanText(raw: string | null, name: string, required: boolean): string {
  if (raw === null || raw === "") {
    if (required) throw new InvalidParamError(`Missing required parameter: ${name}`);
    return "";
  }
  if (raw.length > MAX_TEXT_LENGTH || CONTROL_CHARS_RE.test(raw)) {
    throw new InvalidParamError(`Invalid ${name}: max ${MAX_TEXT_LENGTH} chars, no control characters`);
  }
  return raw;
}

/** Normalize a hex color ("f00", "#BD0000", ...) to an uppercase 6-digit form, or null. */
function cleanColor(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  const m = COLOR_RE.exec(raw.trim());
  if (!m) throw new InvalidParamError(`Invalid color: ${raw} (expected RRGGBB or RGB)`);
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  return hex.toUpperCase();
}

interface CustomBadgeVars {
  title: string;
  subtitle: string;
  titleColor: string;
  subtitleColor: string;
  startColor: string;
  endColor: string;
  iconColor: string;
  /** Pre-built icon markup, or an empty string when the badge has no icon. */
  iconGroup: string;
}

/** X offset of the text block, and the right padding of the custom badge. */
const CUSTOM_TEXT_LEFT_ICON = 60;
const CUSTOM_TEXT_LEFT_PLAIN = 16;
const CUSTOM_PADDING_RIGHT = 16;

/** Render the custom template, sizing the card to the measured text width. */
function renderCustom(vars: CustomBadgeVars): string {
  const hasIcon = vars.iconGroup !== "";
  const hasSubtitle = vars.subtitle !== "";
  const textLeft = hasIcon ? CUSTOM_TEXT_LEFT_ICON : CUSTOM_TEXT_LEFT_PLAIN;

  const titleWidth = measureTextWidth(vars.title, 16, 500);
  const subtitleWidth = hasSubtitle ? measureTextWidth(vars.subtitle, 17, 800) : 0;
  const needed = Math.ceil(textLeft + Math.max(titleWidth, subtitleWidth) + CUSTOM_PADDING_RIGHT);
  const base = templateWidth(templates.custom) ?? needed;
  const template = withWidth(templates.custom, Math.max(base, needed));

  const subtitleLine = hasSubtitle
    ? `<text transform="translate(${textLeft} 28.5)" fill="#${vars.subtitleColor}" ` +
      `style="white-space: pre" xml:space="preserve" font-family="Inter" font-size="17" ` +
      `font-weight="800" letter-spacing="0em"><tspan x="0" y="15.1818">${escapeXml(vars.subtitle)}</tspan></text>`
    : "";

  return render(
    template,
    {
      icon_group: vars.iconGroup,
      text_left: String(textLeft),
      title_y: hasSubtitle ? "9.5" : "18",
      title: vars.title,
      title_color: `#${vars.titleColor}`,
      subtitle_line: subtitleLine,
      start_color: `#${vars.startColor}`,
      end_color: `#${vars.endColor}`,
    },
    ["icon_group", "subtitle_line"],
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
