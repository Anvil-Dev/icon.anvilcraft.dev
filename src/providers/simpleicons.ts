import { readCache, writeCache } from "../cache";
import type { Env } from "../env";

const CDN_BASE = "https://cdn.simpleicons.org";
const ICON_TTL = 24 * 60 * 60; // 24 hours; simple-icons releases weekly and paths are stable

/** The data of a simple-icons glyph: its path and the brand color. */
export interface SimpleIcon {
  path: string;
  brandColor: string;
}

/** Thrown when the CDN reports 404: the requested slug is not a known icon. */
export class UnknownIconError extends Error {
  constructor(slug: string) {
    super(`Unknown simple-icons slug: ${slug}`);
    this.name = "UnknownIconError";
  }
}

/** Thrown when the simple-icons CDN fails or returns an unexpected payload. */
export class SimpleIconsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleIconsApiError";
  }
}

/** Path data must contain nothing but SVG path syntax; the CDN is trusted but verified. */
const PATH_RE = /^[A-Za-z0-9 .,:;+\-]+$/;

/**
 * Fetch an icon from simpleicons.org, cached in KV for ICON_TTL.
 * Returns the raw path data (24x24 viewBox) plus the brand color, which the
 * caller can use as the default icon color.
 */
export async function getIcon(env: Env, ctx: ExecutionContext, slug: string): Promise<SimpleIcon> {
  const cacheKey = `custom:icon:${slug}`;
  const cached = await readCache<SimpleIcon>(env.ICON_CACHE, cacheKey);
  if (cached?.path) return cached;

  const res = await fetch(`${CDN_BASE}/${slug}`, {
    headers: { "User-Agent": "icon.anvilcraft.dev (https://icon.anvilcraft.dev)" },
  });
  if (res.status === 404) throw new UnknownIconError(slug);
  if (!res.ok) throw new SimpleIconsApiError(`simpleicons CDN responded with HTTP ${res.status}`);

  const svg = await res.text();
  const path = svg.match(/<path d="([^"]+)"/)?.[1];
  const brandColor = svg.match(/<svg[^>]*fill="#([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase() ?? "FFFFFF";
  if (!path || !PATH_RE.test(path)) {
    throw new SimpleIconsApiError(`simpleicons CDN returned an unexpected payload for ${slug}`);
  }

  const icon: SimpleIcon = { path, brandColor };
  ctx.waitUntil(writeCache(env.ICON_CACHE, cacheKey, icon, ICON_TTL));
  return icon;
}
