import { CI_TTL, DOWNLOADS_TTL, readCache, writeCache } from "./cache";
import type { CiStatus, Env } from "./env";
import { CURSEFORGE_ICON, GITHUB_ICON, MODRINTH_ICON } from "./icons";
import * as curseforge from "./providers/curseforge";
import * as github from "./providers/github";
import * as modrinth from "./providers/modrinth";
import { getIcon, UnknownIconError } from "./providers/simpleicons";
import { escapeXml, formatNumber, measureTextWidth, render, templates, templateWidth, withWidth } from "./templates";

/** Route parameters are restricted to characters safe for upstream APIs and XML output. */
const PARAM_RE = /^[A-Za-z0-9._-]+$/;

/** Badge layout styles selectable via the `style` query parameter. */
type BadgeStyle = "default" | "minimal";
const STYLES = new Set<string>(["default", "minimal"]);

function parseStyle(query: URLSearchParams): BadgeStyle {
  const raw = query.get("style") ?? "default";
  if (!STYLES.has(raw)) {
    throw new InvalidParamError(`Invalid style: ${raw} (allowed: default, minimal)`);
  }
  return raw as BadgeStyle;
}

const INDEX_TEXT = `icon.anvilcraft.dev — dynamic SVG badges

Documentation & source: https://github.com/Anvil-Dev/icon.anvilcraft.dev

Endpoints:
  /modrinth/downloads/:slug            Modrinth downloads badge   (cached 3h)
  /curseforge/downloads/:slug          CurseForge downloads badge (cached 3h)
  /github/downloads/:owner/:repo       GitHub release downloads   (cached 3h)
  /github/issues/:owner/:repo          GitHub open issues         (cached 3h)
  /github/prs/:owner/:repo             GitHub open pull requests  (cached 3h)
  /github/workflow/:owner/:repo/:workflow    GitHub Actions CI status   (cached 60s)
  /custom?title=..&subtitle=..&icon=.....    Fully customizable badge   (cached 24h)

Example: /github/downloads/Anvil-Dev/AnvilCraft

All badge endpoints accept ?style=default (two lines, 40px icon) or
?style=minimal (one line, 20px icon).
`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
      return new Response(INDEX_TEXT, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    let style: BadgeStyle;
    try {
      style = parseStyle(url.searchParams);
    } catch (error) {
      return badRequest((error as Error).message);
    }

    const [provider, kind, ...params] = segments;
    if (!params.every((p) => PARAM_RE.test(p))) {
      return badRequest("Invalid path parameter: only [A-Za-z0-9._-] is allowed.");
    }

    if (provider === "custom" && kind === undefined) {
      return customBadge(env, ctx, url.searchParams, style);
    }

    if (kind === "downloads" && provider === "modrinth" && params.length === 1) {
      return downloadsBadge(env, ctx, style, {
        cacheKey: `modrinth:downloads:${params[0]}`,
        template: templates.modrinthDownloads,
        visual: {
          icon: MODRINTH_ICON,
          title: "Modrinth Downloads",
          titleColor: "#E8E8E8",
          subtitleColor: "#00FF73",
          startColor: "#072A12",
          endColor: "#051D0C",
        },
        fetch: () => modrinth.getProjectDownloads(env, params[0]),
      });
    }

    if (kind === "downloads" && provider === "curseforge" && params.length === 1) {
      return downloadsBadge(env, ctx, style, {
        cacheKey: `curseforge:downloads:${params[0]}`,
        template: templates.curseforgeDownloads,
        visual: {
          icon: CURSEFORGE_ICON,
          title: "CurseForge Downloads",
          titleColor: "#E8E8E8",
          subtitleColor: "#F16436",
          startColor: "#2C130B",
          endColor: "#210D08",
        },
        fetch: () => curseforge.getProjectDownloads(env, params[0]),
      });
    }

    if (kind === "downloads" && provider === "github" && params.length === 2) {
      const [owner, repo] = params;
      return downloadsBadge(env, ctx, style, {
        cacheKey: `github:downloads:${owner}/${repo}`,
        template: templates.githubDownloads,
        visual: GITHUB_BADGE("GitHub Downloads", "#FFFFFF"),
        fetch: () => github.getRepoDownloads(env, owner, repo),
      });
    }

    if (kind === "issues" && provider === "github" && params.length === 2) {
      const [owner, repo] = params;
      return downloadsBadge(env, ctx, style, {
        cacheKey: `github:issues:${owner}/${repo}`,
        template: templates.githubIssues,
        visual: GITHUB_BADGE("GitHub Issues", "#3FB950"),
        valueKey: "count",
        format: (n) => `${formatNumber(n)} open`,
        fetch: () => github.getOpenIssueCount(env, owner, repo),
      });
    }

    if (kind === "prs" && provider === "github" && params.length === 2) {
      const [owner, repo] = params;
      return downloadsBadge(env, ctx, style, {
        cacheKey: `github:prs:${owner}/${repo}`,
        template: templates.githubPrs,
        visual: GITHUB_BADGE("GitHub PRs", "#A371F7"),
        valueKey: "count",
        format: (n) => `${formatNumber(n)} open`,
        fetch: () => github.getOpenPullRequestCount(env, owner, repo),
      });
    }

    if (kind === "workflow" && provider === "github" && params.length === 3) {
      const [owner, repo, workflow] = params;
      return ciBadge(env, ctx, style, owner, repo, workflow);
    }

    return badRequest("Unknown endpoint. See / for the list of available badges.");
  },
} satisfies ExportedHandler<Env>;

/** Visual identity of a badge: icon, texts and colors shared by both styles. */
interface BadgeVisual {
  /** Icon markup in the templates' 40x40 icon space, or "" for no icon. */
  icon: string;
  title: string;
  titleColor: string;
  subtitleColor: string;
  startColor: string;
  endColor: string;
}

/** Visual shared by all GitHub badges; only title and subtitle color differ. */
function GITHUB_BADGE(title: string, subtitleColor: string): BadgeVisual {
  return {
    icon: GITHUB_ICON,
    title,
    titleColor: "#E8E8E8",
    subtitleColor,
    startColor: "#202020",
    endColor: "#000000",
  };
}

interface DownloadsBadgeOptions {
  cacheKey: string;
  template: string;
  visual: BadgeVisual;
  fetch: () => Promise<number>;
  /** Template placeholder receiving the formatted value; defaults to "downloads". */
  valueKey?: string;
  /** Custom value formatter; defaults to formatNumber (thousands separators). */
  format?: (n: number) => string;
}

/**
 * Render a counter badge. Values are cached in KV for DOWNLOADS_TTL; on an
 * upstream failure without a cached value we still serve a valid SVG showing
 * "N/A" so badges embedded in READMEs never break.
 */
async function downloadsBadge(
  env: Env,
  ctx: ExecutionContext,
  style: BadgeStyle,
  opts: DownloadsBadgeOptions,
): Promise<Response> {
  const valueKey = opts.valueKey ?? "downloads";
  const format = opts.format ?? formatNumber;
  let value = await readCache<number>(env.ICON_CACHE, opts.cacheKey);

  if (value === null) {
    try {
      value = await opts.fetch();
      ctx.waitUntil(writeCache(env.ICON_CACHE, opts.cacheKey, value, DOWNLOADS_TTL));
    } catch (error) {
      console.error(opts.cacheKey, error);
      return svgResponse(renderCounter(opts, style, valueKey, "N/A"), 0);
    }
  }

  const text = format(value);
  return svgResponse(renderCounter(opts, style, valueKey, text), DOWNLOADS_TTL);
}

/** Render a counter badge value in the requested style. */
function renderCounter(
  opts: DownloadsBadgeOptions,
  style: BadgeStyle,
  valueKey: string,
  text: string,
): string {
  if (style === "minimal") {
    return renderMinimal({
      iconGroup: minimalIcon(opts.visual.icon),
      title: opts.visual.title,
      subtitle: text,
      titleColor: opts.visual.titleColor,
      subtitleColor: opts.visual.subtitleColor,
      startColor: opts.visual.startColor,
      endColor: opts.visual.endColor,
    });
  }
  return render(sizedTemplate(opts.template, opts.visual.title, text), { [valueKey]: text });
}

/**
 * Grow the template when the value text would overflow the card. The badge
 * title is baked into each template, so it is measured from the visual
 * declaration alongside the value text.
 */
function sizedTemplate(template: string, title: string, valueText: string): string {
  const titleWidth = measureTextWidth(title, 16, 500);
  const valueWidth = measureTextWidth(valueText, 17, 800);
  const needed = Math.ceil(60 + Math.max(titleWidth, valueWidth) + 16);
  const base = templateWidth(template) ?? needed;
  return withWidth(template, Math.max(base, needed));
}

/** Render a GitHub Actions CI badge, cached for CI_TTL. */
async function ciBadge(
  env: Env,
  ctx: ExecutionContext,
  style: BadgeStyle,
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
      return svgResponse(renderCiBadge({ name: workflow, status: "unknown", color: "#9F9F9F" }, style), 0);
    }
  }

  return svgResponse(renderCiBadge(status, style), CI_TTL);
}

/** Render a CI status in the requested style. */
function renderCiBadge(status: CiStatus, style: BadgeStyle): string {
  if (style === "minimal") {
    return renderMinimal({
      iconGroup: minimalIcon(GITHUB_ICON),
      title: status.name,
      subtitle: status.status,
      titleColor: "#E8E8E8",
      subtitleColor: status.color,
      startColor: "#202020",
      endColor: "#000000",
    });
  }
  return renderCi(status);
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

/** Minimal layout: icon at (12,18) sized 20x20, single text line with a gap. */
const MINIMAL_TEXT_LEFT_ICON = 40;
const MINIMAL_TEXT_LEFT_PLAIN = 16;
const MINIMAL_GAP = 8;

interface MinimalVars {
  /** Pre-built icon markup (already positioned), or "" for no icon. */
  iconGroup: string;
  title: string;
  subtitle: string;
  titleColor: string;
  subtitleColor: string;
  startColor: string;
  endColor: string;
}

/** Map a 40x40-space icon (template icon box at (12,8)) onto the 20x20 minimal box at (12,18). */
function minimalIcon(icon40: string): string {
  return icon40 === "" ? "" : `<g transform="translate(6 14) scale(0.5)">${icon40}</g>`;
}

/** Render the minimal single-line template, sizing the card to the measured text. */
function renderMinimal(vars: MinimalVars): string {
  const hasIcon = vars.iconGroup !== "";
  const hasSubtitle = vars.subtitle !== "";
  const textLeft = hasIcon ? MINIMAL_TEXT_LEFT_ICON : MINIMAL_TEXT_LEFT_PLAIN;

  const titleWidth = measureTextWidth(vars.title, 16, 500);
  const subtitleWidth = hasSubtitle ? measureTextWidth(vars.subtitle, 17, 800) : 0;
  const needed = Math.ceil(
    textLeft + titleWidth + (hasSubtitle ? MINIMAL_GAP + subtitleWidth : 0) + 16,
  );
  const base = templateWidth(templates.minimal) ?? needed;
  const finalWidth = Math.max(base, needed);
  const template = withWidth(templates.minimal, finalWidth);

  const filterX = textLeft - 5.6;
  const filterWidth = finalWidth - filterX - 6.4;

  const subtitleTspan = hasSubtitle
    ? `<tspan dx="${MINIMAL_GAP}" fill="${vars.subtitleColor}" font-size="17" ` +
      `font-weight="800">${escapeXml(vars.subtitle)}</tspan>`
    : "";

  return render(
    template,
    {
      icon_group: vars.iconGroup,
      text_left: String(textLeft),
      title: vars.title,
      title_color: vars.titleColor,
      subtitle_tspan: subtitleTspan,
      start_color: vars.startColor,
      end_color: vars.endColor,
      filter_x: String(Number(filterX.toFixed(2))),
      filter_width: String(Number(filterWidth.toFixed(2))),
    },
    ["icon_group", "subtitle_tspan"],
  );
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
  style: BadgeStyle,
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

    let iconPath = "";
    let iconColor = cleanColor(query.get("iconColor"));
    if (iconSlug !== null) {
      try {
        const icon = await getIcon(env, ctx, iconSlug);
        iconPath = icon.path;
        iconColor ??= icon.brandColor;
      } catch (error) {
        if (error instanceof UnknownIconError) throw new InvalidParamError(error.message);
        // Transient CDN failure: degrade to an icon-less badge served with no-cache.
        console.error(`custom:icon:${iconSlug}`, error);
        return svgResponse(renderCustomBadge(style, { title, subtitle, titleColor, subtitleColor, startColor, endColor, iconColor: "FFFFFF", iconPath: "" }), 0);
      }
    }

    const svg = renderCustomBadge(style, {
      title,
      subtitle,
      titleColor,
      subtitleColor,
      startColor,
      endColor,
      iconColor: iconColor ?? "FFFFFF",
      iconPath,
    });
    return svgResponse(svg, CUSTOM_TTL);
  } catch (error) {
    if (error instanceof InvalidParamError) return badRequest(error.message);
    throw error;
  }
}

interface CustomBadgeVars {
  title: string;
  subtitle: string;
  titleColor: string;
  subtitleColor: string;
  startColor: string;
  endColor: string;
  iconColor: string;
  /** Raw simple-icons path data (24x24 viewBox), or "" for no icon. */
  iconPath: string;
}

/** Render a custom badge in the requested style. */
function renderCustomBadge(style: BadgeStyle, vars: CustomBadgeVars): string {
  if (style === "minimal") {
    return renderMinimal({
      iconGroup:
        vars.iconPath === ""
          ? ""
          : `<path d="${vars.iconPath}" fill="#${vars.iconColor}" transform="translate(12 18) scale(0.8333333)"/>`,
      title: vars.title,
      subtitle: vars.subtitle,
      titleColor: `#${vars.titleColor}`,
      subtitleColor: `#${vars.subtitleColor}`,
      startColor: `#${vars.startColor}`,
      endColor: `#${vars.endColor}`,
    });
  }
  return renderCustom(vars);
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

/** X offset of the text block, and the right padding of the custom badge. */
const CUSTOM_TEXT_LEFT_ICON = 60;
const CUSTOM_TEXT_LEFT_PLAIN = 16;
const CUSTOM_PADDING_RIGHT = 16;

/** Render the custom template in the default two-line style. */
function renderCustom(vars: CustomBadgeVars): string {
  const hasIcon = vars.iconPath !== "";
  const hasSubtitle = vars.subtitle !== "";
  const textLeft = hasIcon ? CUSTOM_TEXT_LEFT_ICON : CUSTOM_TEXT_LEFT_PLAIN;

  const iconGroup = hasIcon
    ? `<g clip-path="url(#clip0_custom)">` +
      `<path d="${vars.iconPath}" fill="#${vars.iconColor}" transform="translate(12 8) scale(1.6666667)"/>` +
      `</g>`
    : "";

  const titleWidth = measureTextWidth(vars.title, 16, 500);
  const subtitleWidth = hasSubtitle ? measureTextWidth(vars.subtitle, 17, 800) : 0;
  const needed = Math.ceil(textLeft + Math.max(titleWidth, subtitleWidth) + CUSTOM_PADDING_RIGHT);
  const base = templateWidth(templates.custom) ?? needed;
  const finalWidth = Math.max(base, needed);
  const template = withWidth(templates.custom, finalWidth);

  // The drop-shadow filter region must start slightly left of the text block;
  // a fixed region would clip icon-less badges whose text starts at x=16.
  const filterX = textLeft - 5.6;
  const filterWidth = finalWidth - filterX - 6.4;

  const subtitleLine = hasSubtitle
    ? `<text transform="translate(${textLeft} 28.5)" fill="#${vars.subtitleColor}" ` +
      `style="white-space: pre" xml:space="preserve" font-family="Inter" font-size="17" ` +
      `font-weight="800" letter-spacing="0em"><tspan x="0" y="15.1818">${escapeXml(vars.subtitle)}</tspan></text>`
    : "";

  return render(
    template,
    {
      icon_group: iconGroup,
      text_left: String(textLeft),
      title_y: hasSubtitle ? "9.5" : "18",
      title: vars.title,
      title_color: `#${vars.titleColor}`,
      subtitle_line: subtitleLine,
      start_color: `#${vars.startColor}`,
      end_color: `#${vars.endColor}`,
      filter_x: String(Number(filterX.toFixed(2))),
      filter_width: String(Number(filterWidth.toFixed(2))),
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
