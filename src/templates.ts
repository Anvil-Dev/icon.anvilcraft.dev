import curseforgeDownloads from "../template/curseforge-downloads.svg";
import githubCi from "../template/github-ci.svg";
import githubDownloads from "../template/github-downloads.svg";
import modrinthDownloads from "../template/modrinth-downloads.svg";

/** All available badge templates, imported as raw text via Wrangler's Text module rule. */
export const templates = {
  curseforgeDownloads,
  githubCi,
  githubDownloads,
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
 * All values are XML-escaped before substitution. Unknown placeholders are
 * left untouched so a typo fails loudly in the rendered output.
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (original, key: string) => {
    const value = vars[key];
    return value === undefined ? original : escapeXml(value);
  });
}

/** Format a download counter with thousands separators, e.g. 134724 -> "134,724". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "N/A";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Approximate advance widths (fractions of 1em) for Inter, grouped by
 * character class. Good enough to size badges; no font metrics are available
 * in the Workers runtime.
 */
const CHAR_WIDTHS: Array<[RegExp, number]> = [
  [/\s/, 0.27],
  [/[iljI.,:;'!|`]/, 0.3],
  [/[tf()\[\]{}r]/, 0.36],
  [/[mwMW@#%&]/, 0.86],
  [/[A-Z]/, 0.68],
  [/[0-9]/, 0.56],
  [/[a-z]/, 0.53],
];
const DEFAULT_CHAR_WIDTH = 0.55;

/** Estimate the rendered width in px of a text run in the Inter font. */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let ems = 0;
  for (const ch of text) {
    ems += CHAR_WIDTHS.find(([re]) => re.test(ch))?.[1] ?? DEFAULT_CHAR_WIDTH;
  }
  return ems * fontSize * (bold ? 1.04 : 1);
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
