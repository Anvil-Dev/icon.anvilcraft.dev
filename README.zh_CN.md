<div align="center">

# icon.anvilcraft.dev

**面向 Modrinth、CurseForge 与 GitHub 的动态 SVG 徽章，在 Cloudflare 边缘按需生成。**

[English](README.md) | 简体中文

</div>

## 用法

请求徽章 URL，即可在任何可以嵌入图片的地方（Markdown、HTML……）使用返回的 SVG：

| 徽章 | URL | 上游数据 | 缓存 TTL |
| --- | --- | --- | --- |
| Modrinth 下载量 | `https://icon.anvilcraft.dev/modrinth/downloads/:slug` | Modrinth API v2 | 3 小时 |
| CurseForge 下载量 | `https://icon.anvilcraft.dev/curseforge/downloads/:slug` | cfwidget / CurseForge 官方 API | 3 小时 |
| GitHub 下载量 | `https://icon.anvilcraft.dev/github/downloads/:owner/:repo` | GitHub REST（release 资产） | 3 小时 |
| GitHub CI 状态 | `https://icon.anvilcraft.dev/github/ci/:owner/:repo/:workflow` | GitHub REST（workflow runs） | 60 秒 |

示例（AnvilCraft 项目）：

```markdown
![Modrinth Downloads](https://icon.anvilcraft.dev/modrinth/downloads/AnvilCraft)
![CurseForge Downloads](https://icon.anvilcraft.dev/curseforge/downloads/AnvilCraft)
![GitHub Downloads](https://icon.anvilcraft.dev/github/downloads/Anvil-Dev/AnvilCraft)
![CI Status](https://icon.anvilcraft.dev/github/ci/Anvil-Dev/AnvilCraft/ci.yml)
```

所有端点都返回 `image/svg+xml`，并附带与缓存 TTL 一致的 `Cache-Control`
响应头。当上游 API 失败且没有缓存值时，徽章仍会正常渲染（显示 `N/A` /
`unknown`），保证嵌入的图片永不损坏。

## 工作原理

- 单个 [Cloudflare Worker](src/index.ts) 负责路由请求、校验路径参数，并通过
  简单的 `${占位符}` 字符串替换渲染四个 [SVG 模板](template/)之一（替换值
  均做 XML 转义）。
- 上游结果（下载计数或 CI 状态）按合适的 TTL 缓存在 **Cloudflare KV** 中，
  因此 Workers 免费额度（每日 10 万请求、10ms CPU）和 KV 免费额度绰绰有余，
  站点可以零成本运行。
- 配置了 GitHub OAuth App 的**客户端凭证**（`GH_CLIENT_ID` /
  `GH_CLIENT_SECRET` secret）后，GitHub 请求会携带 Basic 认证，针对公开
  数据享有独立的每小时 5000 次配额，而不是共享的每小时 60 次未认证限额。未
  配置 secret 时回退为未认证请求，并由 KV 缓存兜底。
- CurseForge 官方 API 没有免 key 通道：默认使用免费的
  [cfwidget](https://www.cfwidget.com/) JSON API；设置可选的
  `CURSEFORGE_API_KEY` secret 即可切换到 CurseForge 官方 API。

## 本地开发

```bash
npm install
npm run dev        # wrangler dev，内置本地 KV 模拟
npm run typecheck  # TypeScript 严格模式类型检查
```

然后访问例如 `http://localhost:8787/github/downloads/Anvil-Dev/AnvilCraft`。

## 部署

仓库自带 GitHub Actions 工作流
（[.github/workflows/deploy.yml](.github/workflows/deploy.yml)），每次推送
`main` 都会先类型检查再自动部署。首次需要完成以下一次性配置：

1. **创建 KV 命名空间**，并将输出的 `id` 填入
   [`wrangler.toml`](wrangler.toml)：

   ```bash
   npx wrangler kv namespace create ICON_CACHE
   ```

2. 工作流需要的 **GitHub 仓库 secret**：
   - `CLOUDFLARE_API_TOKEN` —— 具备 *Edit Cloudflare Workers* 权限的 API 令牌。
   - `CLOUDFLARE_ACCOUNT_ID` —— 你的 Cloudflare 账户 ID。

3. **Cloudflare Worker secret**（可选，推荐）：

   ```bash
   npx wrangler secret put GH_CLIENT_ID       # GitHub OAuth App 的 client id
   npx wrangler secret put GH_CLIENT_SECRET   # GitHub OAuth App 的 client secret
   npx wrangler secret put CURSEFORGE_API_KEY     # 可选的 CurseForge 官方 API key
   ```

   GitHub OAuth App 无需任何特殊 scope 或回调流程——这里只把它的 client
   id/secret 用于面向公开 REST 端点的客户端凭证认证。

4. **自定义域名**：`wrangler.toml` 已声明 `icon.anvilcraft.dev` 为自定义域名，
   前提是该域名 DNS 由 Cloudflare 托管。部署一次（`npx wrangler deploy` 或推送
   `main`）后 Cloudflare 会自动签发证书。

## 技术栈

TypeScript（strict）· Cloudflare Workers + KV · Wrangler · 零运行时依赖——
SVG 由纯字符串模板构建，CPU 消耗远低于免费档 10ms 限制。
