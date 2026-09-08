# web_fetch 在 fake-ip 网络下被拦：分层分析与接管方案

- **会话**: S142（dsh-serenity-plugin 长期维护）
- **版本**: v1.30.12
- **日期**: 2026-09-08
- **状态**: 已实现（本地 deploy 生效，待 restart 后运行时验证）
- **用户原话**: "这个网页获取被dsh安全机制拦截我也很困惑，我需要关了它，看看能从哪个层面想办法" → 拍板 "我选择 L3，但是要屏蔽掉 dsh 自身注册的 tool"

---

## 1. 现象与根因（代码级实证，DSH 0.1.2-rc.1）

| 项 | 内容 |
|---|---|
| 现象 | `web_fetch` 恒失败：`URL hostname "X" resolves to a non-public IP address`（错误码 `WEB_BLOCKED_URL`） |
| 拦截点 | `@deepseek-ai/dsh-web-fetch-http/lib/index.js:69` —— `if (!isPublicIpAddress(entry.address)) throw new WebError(...)`（**无条件 throw，无开关分支**） |
| 判据 | 同文件 `:32-39` `isPublicIpAddress` = `ipaddr.js` 的 `parsed.range() === "unicast"` |
| DNS 实证 | `dsh-develop sys curl -v` → `cdn.jsdelivr.net` 解析为 **198.18.1.85**（Clash/mihomo fake-ip 段 `198.18.0.1/16`） |
| 归类 | ipaddr.js 把 `198.18.0.0/15`（RFC 2544 benchmarking）归为 **reserved**，非 unicast → 拦截 |

**结论：DSH 没有误判，是本地 DNS 在说谎。** fake-ip 是 TUN 模式的正常设计，但它的答案不满足宿主"必须公网单播"的判据。

## 2. 分层选项（含否决理由 R↓）

| 层 | 做法 | 可行 | 代价 / 否决理由 |
|---|---|---|---|
| **L1 DSH 配置** | 找"允许非公网"开关 | ❌ | `dsh-web-fetch-http` 的 Config 只有 5 个配额字段（maxResponseBytes / maxBodyChars / timeoutMs / maxRedirects / userAgent）；`dsh-web` 只有 `searchProvider` / `fetchProvider`。**只能换 provider，不能关校验** |
| **L2① 网络逐域名** | 加进 `custom/openclash_custom_fake_filter.list`（先例 `+.argotunnel.com`） | ✅ | 模型要抓任意站点 → 打地鼠，不可持续 |
| **L2② 网络全局** | `enhanced-mode: redir-host` 或 `fake-ip-filter-mode: whitelist` | ✅ | 影响全家所有设备的 DNS 行为；当初选 fake-ip 就是为 TUN |
| **L3 ACC 插件**（**采纳**） | ACC 注册自己的 fetch provider | ✅ | ~100 行 + 测试；零改 DSH；升级不丢 |
| **L4 改 DSH** | 改 `lib/index.js:69` | ⚠️ | 违反"零改 DSH"；`dsh` 升级即被覆盖 |
| **L5 绕开** | `dsh-develop sys curl` / anysearch extract | ✅ | 平台 `web_fetch` 对模型仍不可用 |

## 3. 采纳方案（L3 + 屏蔽宿主内置）

### 3.1 复用而非重写

宿主 `HttpFetchProvider` **已导出**，且构造器第二参数就是 `resolveAddresses`（`HttpFetchResolver`）：

```ts
new HttpFetchProvider(limits, resolveAddresses)   // limits: HttpFetchLimits
```

因此重定向策略（仅同源）、字节/字符配额、字符集解码、连接固定（DNS 重绑定防护）**全部继承宿主实现**，我们只替换"地址可达性"这一条判据。

### 3.2 放宽的判据（最小放宽）

`isAllowedFetchAddress(addr) = 公网单播 ∪ fake-ip 段(198.18.0.0/15)`

其余**依旧拒绝**：loopback / link-local（含云元数据 `169.254.169.254`）/ RFC1918 / CGNAT `100.64/10` / 保留段 / 组播 / IPv6 ULA / IPv6 link-local；IPv6 仅放行全局单播 `2000::/3`，`::ffff:a.b.c.d` 按内嵌 IPv4 判定。

拒绝语义与宿主一致：**任一地址不合法即整体拒绝**（防 DNS 重绑定），错误码沿用 `WEB_BLOCKED_URL`。

### 3.3 屏蔽宿主内置（用户要求）

宿主内置 provider 由**本包 bundle patch** 关闭——`hooks/dsh-serenity-hooks/cordis.patch.yml`：

```yaml
- id: web-fetch-http
  name: '@deepseek-ai/dsh-web-fetch-http'
  disabled: true
```

- **为什么不是改宿主 profile**：宿主 app-boot 的 `applyEntryPatches` 把**所有 bundle 的 patch 与本 profile 的 cordis.patch.yml 展平成一个列表**按序应用（`loadProfile` → `composeEntries`）。本包在 `dsh.profile.bundles` 末尾 → 它的 patch 在所有宿主 bundle 之后生效。**因此修复随插件交付，不需要改机器配置。**
- **未命中只告警跳过**（宿主源码注释："A patch that matches nothing warns and is skipped"）→ 宿主换版本时不会炸。
- **为什么用同一 id `http`**：`HttpFetchProvider` 的 `id` 是实例字段（`LOCAL_FETCH_PROVIDER_ID = 'http'`）。接管同一 id 后，宿主 `web` 的既有配置 `fetchProvider: http` **无需改动**——避免了"整体替换 web 配置对象"（patch 的 `config` 是替换非深合并，会连 `searchProvider` 一起覆盖）。
- **两者不能并存**：同时注册同一 id 会 `WEB_DUPLICATE_PROVIDER`——这是刻意保留的响亮信号。

### 3.4 失败策略

- 后端包用**动态 import**：宿主版本里若没有 `@deepseek-ai/dsh-web-fetch-http`，只降级为一条告警（**绝不因缺一个可选后端让整机启动失败**——宿主对插件 apply 抛错 = 整个 dsh 启动失败）。
- 错误对象用本地 `fetchError(message, code)` 而非 `import { WebError }`：`dsh-tool-web` 只渲染 `error.message`、不判 `instanceof`（源码实证），而宿主 peer 包在测试环境不可解析（与既有测试 `vi.mock('@deepseek-ai/dsh-tools')` 同因）。

## 4. 验证

| 验证项 | 手段 | 结果 |
|---|---|---|
| 地址判据 | `tests/web-fetch-provider.test.ts` 9 用例（放行公网/fake-ip；拒 13 个私网/保留段；IPv6 分类；mapped 语义） | ✓ |
| 注册形态 | 同上（provider id = `http`、`available()` 为真；web 服务缺失只告警不抛错） | ✓ |
| 全量回归 | `dsh-develop test` | **71 files / 1002 tests** ✓（+1 文件 / +9 用例） |
| 类型/构建 | `typecheck` 双面 + `build` | ✓ |
| **patch 合成实证** | 新增 `dsh-develop dump-config`（宿主 `dsh --dump-config` 与 boot 同一 `applyEntryPatches`） | `- id: web-fetch-http … disabled: true`，`# patched by @shgroup/dsh-serenity-hooks` ✓ |
| 运行时 | 需 `restart-web` 后 `web_fetch` 实测（本方案生效点） | ⏸ 待执行 |

## 5. 回滚

1. `cordis.patch.yml` 中删掉 `web-fetch-http` 的 `disabled` 行（或改 `disabled: false`）；
2. 同时把插件配置 `serenity-hooks.webFetch.enabled` 设为 `false`（否则 `WEB_DUPLICATE_PROVIDER`）。

## 6. 边界与已知限制

- 只放宽"地址可达性"一条；URL 校验、同源重定向、配额、二进制拒绝**仍由宿主实现执行**。
- 若 CCC 使用非默认 `fake-ip-range`（如 `240.0.0.0/4`），需同步 `FAKE_IP_OCTET_*` 常量。
- 内网服务（如 `192.168.1.x`）**仍然拒绝**——`web_fetch` 不用于抓内网；内网访问走 `ssh-connect` / CCC 自己的 MSM。
