<div align="center">

# icon.anvilcraft.dev

**Dynamic SVG badges for Modrinth, CurseForge and GitHub, generated on demand at the Cloudflare edge.**

English | [简体中文](README.zh_CN.md)

</div>

## Usage

Request a badge URL and embed the SVG anywhere an image can go (Markdown, HTML, ...):

| Badge | URL | Upstream data | Cache TTL |
| --- | --- | --- | --- |
| Modrinth downloads | `https://icon.anvilcraft.dev/modrinth/downloads/:slug` | Modrinth API v2 | 3 hours |
| CurseForge downloads | `https://icon.anvilcraft.dev/curseforge/downloads/:slug` | cfwidget / official CurseForge API | 3 hours |
| GitHub downloads | `https://icon.anvilcraft.dev/github/downloads/:owner/:repo` | GitHub REST (release assets) | 3 hours |
| GitHub issues (open/completed/not planned) | `https://icon.anvilcraft.dev/github/issues/:owner/:repo` | GitHub search API | 3 hours |
| GitHub PRs (open/merged/closed) | `https://icon.anvilcraft.dev/github/prs/:owner/:repo` | GitHub search API | 3 hours |
| GitHub CI status | `https://icon.anvilcraft.dev/github/workflow/:owner/:repo/:workflow` | GitHub REST (workflow runs) | 60 seconds |
| Custom badge | `https://icon.anvilcraft.dev/custom?title=...&subtitle=...&icon=...` | [simpleicons.org](https://simpleicons.org) | 24 hours |

Examples (the AnvilCraft project):

```markdown
![Modrinth Downloads](https://icon.anvilcraft.dev/modrinth/downloads/AnvilCraft)
![CurseForge Downloads](https://icon.anvilcraft.dev/curseforge/downloads/AnvilCraft)
![GitHub Downloads](https://icon.anvilcraft.dev/github/downloads/Anvil-Dev/AnvilCraft)
![GitHub Issues](https://icon.anvilcraft.dev/github/issues/Anvil-Dev/AnvilCraft)
![GitHub PRs](https://icon.anvilcraft.dev/github/prs/Anvil-Dev/AnvilCraft)
![CI Status](https://icon.anvilcraft.dev/github/workflow/Anvil-Dev/AnvilCraft/ci.yml)
```

### Badge styles

Every badge endpoint accepts an optional `style` query parameter:

| Value | Layout |
| --- | --- |
| `default` (fallback) | 56px high, two lines (title over subtitle), 40px icon |
| `compact` | 40px high, single line (title + subtitle with a gap), 28px icon |

```markdown
![GitHub Issues](https://icon.anvilcraft.dev/github/issues/Anvil-Dev/AnvilCraft?style=compact)
```

### Custom badges

`/custom` renders a fully parameterized badge (no upstream account data):

```markdown
![License](https://icon.anvilcraft.dev/custom?title=Licensed%20By&subtitle=GPL%20v3&titleColor=E8E8E8&subtitleColor=BD0000&startColor=3A0101&endColor=170000&icon=gplv3&iconColor=BD0000)
```

| Parameter | Required | Description |
| --- | --- | --- |
| `title` | ✅ | Title text (16px, ≤64 chars) |
| `subtitle` | | Subtitle text (17px bold); the title is vertically centered when omitted |
| `titleColor` | | Title color, `RRGGBB` or `RGB` (default `E8E8E8`) |
| `subtitleColor` | | Subtitle color (default `FFFFFF`) |
| `startColor` / `endColor` | | Background gradient top/bottom colors (defaults `202020` / `000000`) |
| `icon` | | [simple-icons](https://simpleicons.org) slug, e.g. `gplv3` (omit for no icon) |
| `iconColor` | | Icon color; defaults to the icon's official brand color |

Invalid parameters (missing `title`, malformed colors, unknown icon slugs)
return a `400` error.

All endpoints return `image/svg+xml` with a `Cache-Control` header matching the
cache TTL. If the upstream API fails and no cached value exists, the badge is
still rendered (showing `N/A` / `unknown`) so embedded images never break.

## How it works

- A single [Cloudflare Worker](src/index.ts) routes the request, validates path
  parameters and renders one of the four [SVG templates](template/) by simple
  `${placeholder}` string substitution (values are XML-escaped).
- Upstream answers (a download counter or a CI status) are cached in
  **Cloudflare KV** with an appropriate TTL, so the Workers free tier
  (100,000 requests/day, 10 ms CPU) and the KV free tier are more than enough,
  and the site runs at zero cost.
- GitHub requests are sent with an OAuth App's **client credentials**
  (`GH_CLIENT_ID` / `GH_CLIENT_SECRET` secrets) when configured, giving
  a dedicated 5,000 requests/hour quota for public data instead of the shared
  60 requests/hour unauthenticated limit. Without the secrets the worker falls
  back to unauthenticated requests, absorbed by the KV cache.
- CurseForge has no keyless official API: by default the free
  [cfwidget](https://www.cfwidget.com/) JSON API is used; set the optional
  `CURSEFORGE_API_KEY` secret to switch to the official CurseForge API.

## Local development

```bash
npm install
npm run dev        # wrangler dev, local KV simulation included
npm run typecheck  # strict TypeScript check
```

Then open e.g. `http://localhost:8787/github/downloads/Anvil-Dev/AnvilCraft`.

## Deployment

The repository ships a GitHub Actions workflow
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) that typechecks
and deploys on every push to `main`. One-time setup:

1. **Create the KV namespace** and paste the printed `id` into
   [`wrangler.toml`](wrangler.toml):

   ```bash
   npx wrangler kv namespace create ICON_CACHE
   ```

2. **GitHub repository secrets** required by the workflow:
   - `CLOUDFLARE_API_TOKEN` — an API token with *Edit Cloudflare Workers*
     permissions.
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id.

3. **Cloudflare Worker secrets** (optional, recommended):

   ```bash
   npx wrangler secret put GH_CLIENT_ID       # GitHub OAuth App client id
   npx wrangler secret put GH_CLIENT_SECRET   # GitHub OAuth App client secret
   npx wrangler secret put CURSEFORGE_API_KEY     # optional official CurseForge key
   ```

   The GitHub OAuth App needs no special scopes or callback flow — only its
   client id/secret pair is used for client-credentials authentication against
   public REST endpoints.

4. **Custom domain**: `wrangler.toml` already declares
   `icon.anvilcraft.dev` as a custom domain; the zone must be managed by
   Cloudflare. Deploy once (`npx wrangler deploy` or push to `main`) and
   Cloudflare provisions the certificate automatically.

## Tech stack

TypeScript (strict) · Cloudflare Workers + KV · Wrangler · zero runtime
dependencies — SVGs are built by plain string templates, keeping CPU time far
below the 10 ms free-tier limit.

## License

Code: [AGPL-3.0-only](LICENSE)

The badge designs in [`template/`](template/) are derived from
[devins-badges](https://github.com/intergrav/devins-badges), which is
released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
(see [`template/NOTICE`](template/NOTICE)).
