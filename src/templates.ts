import curseforgeDownloads from "../template/curseforge-downloads.svg";
import custom from "../template/custom.svg";
import githubCi from "../template/github-ci.svg";
import githubDownloads from "../template/github-downloads.svg";
import githubIssues from "../template/github-issues.svg";
import githubPrs from "../template/github-prs.svg";
import minimal from "../template/minimal.svg";
import modrinthDownloads from "../template/modrinth-downloads.svg";
import { INTER_ASCII_WIDTHS } from "./font-metrics";

/** All available badge templates, imported as raw text via Wrangler's Text module rule. */
export const templates = {
  curseforgeDownloads,
  custom,
  githubCi,
  githubDownloads,
  githubIssues,
  githubPrs,
  minimal,
  modrinthDownloads,
} as const;

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape a value so it is safe to embed in SVG/XML text and attributes. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/**
 * Replace every `${key}` placeholder in a template with the given values.
 * Values are XML-escaped before substitution, except keys listed in `rawKeys`,
 * which are inserted verbatim — reserve those for markup constructed by the
 * worker itself (never for user input). Unknown placeholders are left
 * untouched so a typo fails loudly in the rendered output.
 */
export function render(
  template: string,
  vars: Record<string, string>,
  rawKeys: readonly string[] = [],
): string {
  return template.replace(/\$\{(\w+)\}/g, (original, key: string) => {
    const value = vars[key];
    if (value === undefined) return original;
    return rawKeys.includes(key) ? value : escapeXml(value);
  });
}

/** Format a download counter with thousands separators, e.g. 134724 -> "134,724". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "N/A";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Font weights used by the badge templates, matching the metrics table. */
export type BadgeFontWeight = 500 | 800;

/** Fallback advance width for non-ASCII glyphs (e.g. CJK is roughly 1em). */
const NON_ASCII_WIDTH = 1;

/**
 * Measure the rendered width in px of a text run using the exact Inter
 * advance widths extracted at build time (see scripts/gen-font-metrics.mjs).
 */
export function measureTextWidth(text: string, fontSize: number, weight: BadgeFontWeight): number {
  const widths = INTER_ASCII_WIDTHS[weight];
  let ems = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    ems += code >= 32 && code <= 126 ? widths[code - 32] : NON_ASCII_WIDTH;
  }
  return ems * fontSize;
}

/**
 * Return a copy of a badge template resized to a new width. All width-bound
 * coordinates (root svg/viewBox, background rect, border rect, drop-shadow
 * filter region and gradient midpoint) are shifted by the same delta, so the
 * templates stay pixel-consistent.
 */
export function withWidth(svg: string, newWidth: number): string {
  const root = svg.match(/<svg width="(\d+)"/);
  if (!root) return svg;
  const delta = newWidth - Number(root[1]);
  if (delta === 0) return svg;
  const shift = (n: string, by: number): string => {
    const v = Number(n) + by;
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
  };
  return svg
    .replace(
      /(<svg width=")\d+(" height="\d+" viewBox="0 0 )\d+( \d+")/,
      (_m, a: string, b: string, c: string) => `${a}${newWidth}${b}${newWidth}${c}`,
    )
    .replace(
      /(<rect width=")[\d.]+(" height="\d+" rx="8")/,
      (_m, a: string, b: string) => `${a}${newWidth}${b}`,
    )
    .replace(
      /(<rect x="1\.05" y="1\.05" width=")([\d.]+)(")/,
      (_m, a: string, n: string, b: string) => `${a}${shift(n, delta)}${b}`,
    )
    .replace(
      /(<filter id="[^"]+" x="[\d.]+" y="[\d.]+" width=")([\d.]+)(")/,
      (_m, a: string, n: string, b: string) => `${a}${shift(n, delta)}${b}`,
    )
    .replace(
      /(x1=")([\d.]+)(" y1="0" x2=")([\d.]+)(" y2="\d+")/,
      (_m, a: string, n1: string, b: string, n2: string, c: string) =>
        `${a}${shift(n1, delta / 2)}${b}${shift(n2, delta / 2)}${c}`,
    );
}

/** The declared pixel width of a badge template, or null when unknown. */
export function templateWidth(svg: string): number | null {
  const root = svg.match(/<svg width="(\d+)"/);
  return root ? Number(root[1]) : null;
}
