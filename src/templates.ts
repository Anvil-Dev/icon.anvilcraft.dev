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

/** Format a download counter compactly, e.g. 1234567 -> "1.23M", 12345 -> "12.3K". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "N/A";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${trimTrailingZeros(v >= 100 ? Math.round(v).toString() : v.toFixed(2))}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${trimTrailingZeros(v >= 100 ? Math.round(v).toString() : v.toFixed(1))}K`;
  }
  return Math.round(n).toString();
}

function trimTrailingZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
