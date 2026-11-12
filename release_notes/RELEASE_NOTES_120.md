## v1.2.0 (Routing Hardening)

路由加固版：把「页面结论」和「真实路由」对齐到同一份解析与判定，收窄降级直连的重发边界，并修掉设置页会让绑定、旁路与端点状态互相脱节的一组问题。

基于 `v1.1.1` 基线，**无配置字段迁移、无备份 Schema 变更**（文件仍是 `version: 2`），minor 级发布。两处可感知的行为变化——域名规则归一化、降级重试边界收窄——见下。

### 修复

- **域名规则先归一化再比对（P1）。** `onlyHosts` / `bypassHosts` 的解析此前在页面与 Host 两端不一致：全角逗号会把两条规则粘成一条永不适配的条目，尾点、连续点、重复通配前缀（`..foo`、`*.*.foo`）同样无法被字面匹配，而 `.*` / `*.*` 又被页面报成「永不匹配」、Host 却按「匹配一切」执行。现在 `splitHostRules` 兼容全角逗号（IME 常见输出），`normalizeHostRule` 统一剥离重复前导 `.` / `*.`、去掉尾点、合并连续点，`.*` / `*.*` 归一化为 `*`；规则在落盘时按同一拼写保存，`parseHostList` / `deadRuleEntries` / `decide` 来自同一份解析。真正无法成为主机名的条目仍原样保留，不会扩大匹配面。
- **含义变化的规则不再静默（P1）。** 设置页用 `reinterpretedRuleEntries` 与 1.1.x 的归一化结果比较，在输入框下逐条列出「自 1.2.0 起按不同方式解释」的条目；`*.example.com` / `.example.com` / `*` 这些含义从未改变的写法不会被误报，死条目提示优先。
- **降级直连只在连接建立阶段触发（P1）。** 此前 `ECONNRESET` 与调用方 `AbortSignal.timeout()` 都被当成「代理宕机」并重发同一请求：POST 可能被执行两次，body 为流时还会抛 `TypeError` 并掩盖原始错误。现在只有能证明请求尚未送达上游的失败才降级——`ECONNREFUSED`、`EHOSTUNREACH`、`ENETUNREACH`、连接阶段 `ETIMEDOUT` / `ConnectTimeoutError`；`ECONNRESET` 与调用方超时直接以原始错误失败。新增 `canReplayRequest`：流式 body（Node `Readable`、`ReadableStream`、异步迭代器）与携带 body 的 `Request` 不再重发。
- **设置写入不再关闭尚未发请求的流持有的 dispatcher（P2）。** 设置写入会重建路由表，而适配器要到第一次 `next()` 才发请求；旧实现立即关闭上一代 dispatcher，导致「流已创建、写入已落地」窗口内的用户请求直接 `fetch failed`。现在以 claim 计数管理占用：rebuild 只标记退役，作用域首次发请求、或流结束且从未发请求时才释放，最后一个占用释放后才真正关闭；专用搜索 dispatcher 与 dispose 走同一规则。
- **全局旁路下自检、探针与卡片和真实路由一致（P2）。** `createProxyTable` 此前未收到 `bypassAll`，表内路由仍判定为 `proxy`，自检把探针送进刚被绕过的代理并报 `viaProxy=true`，卡片继续显示「走代理」。现在旁路参数传入表内路由与专用搜索路由，自检冷却键纳入 `bypassAll`，卡片头显示旁路警示条、pill 改为「旁路直连」。
- **批量「使用默认代理」同时清空预设绑定（P2）。** `profileId` 在 Host 解析中优先于 `useDefault`，按钮此前只写 `useDefault`，绑定预设的卡片仍在走旧预设。现在用共享 `bindingFields` 同时写入 `profileId=''` 与 `useDefault=true`，一次写入覆盖全部卡片，失败回滚两个字段。
- **预设改名/删除同步搜索分流绑定（P2）。** `searchProxyProfileId` 是顶层字段，改名后仍指向旧名称，搜索会被按「预设不存在」拒绝。改名在同一次写入中顺带改写该字段；删除确认框列出搜索分流依赖，但不自动清空——`dedicated` 下宁可拒绝搜索，也不悄悄改走直连。
- **半填凭据不再提供「设为默认代理」（P2）。** 卡片的 `complete` 与 `why` 现在同源于 `defaultProxyProblem`：只填用户名或只填密码的端点不再被提升为默认代理，也就不会连累所有继承默认的卡片。
- **尾点 IPv6 在页面与 Host 两端同判为非法（P3）。** 尾点此前先被剥离再判 IPv6，`::1.` 因此被判合法，而 Host 用 `[::1.]` 拼 URL 抛 `Invalid URL`。现在尾点只对 DNS 名称生效，IPv6 字面量按原样校验；判定接受的每个主机都必须能拼出 `new URL` 可解析的代理地址。
- **环境变量代理校验主机并识别 `socks5h://`（P3）。** `parseProxyEnvValue` 此前只做 URL 解析，`my_proxy`、`a..b` 这类无法作为代理地址的主机会被发布成谁都建不出路由的预设；`socks5h://` 又不被识别，导致可用的 `ALL_PROXY` 被静默跳过。现在主机交给共享的 `proxyHostProblem` 判定，失败即继续看下一个变量，`socks5h://` 与 `socks://` 一样识别为 SOCKS5。
- **本机/内网识别补齐 `localhost.` 与 IPv4-mapped IPv6（P3）。** 双栈套接字报告的 `::ffff:127.0.0.1`、WHATWG 回写的十六进制形式，以及绝对域名写法 `localhost.` 此前都未命中直连判定，请求被强推给到不了它们的前向代理。现在尾点先剥离再判定，`::ffff:<v4>` 的两种写法都解码成 IPv4 参与同一套网段判定。
- **粘贴纯 `socks5://` 清除残留 `proxyTls`（P3）。** `splitProxyUrl` 只在 URL 声明 TLS 时写 `proxyTls`，把 `socks5://` 粘到已开启 TLS 隧道的卡片上会残留 `proxyTls=true`，握手打到普通 SOCKS5 代理后失败。现在 `proxyTls` 始终显式写入（含 `false`），粘贴即完整端点声明。
- **CI 门禁（P3）。** 新增 `.github/workflows/verify.yml`：每次 push 与 PR 在 Node `22.20.0`（`engines` 下界）上执行 `npm ci` 与 `npm run verify`，与本地发版校验使用同一条命令。

### 行为变化

- **少数手写域名规则的含义会改变。** `a.com，b.com`（全角逗号）现在按两条规则处理；`example.com.`、`a..b.com`、`..foo`、`*.*.foo` 会归一化成 `example.com`、`a.b.com`、`foo`；`.*` / `*.*` 仍匹配一切，但不再被误报为死条目。设置页会逐条列出这些「自 1.2.0 起按不同方式解释」的条目。
- **降级直连不再覆盖 `ECONNRESET` 与调用方超时。** 依赖「瞬时 reset 自愈」的用法会感知为「不再自愈」：这是有意的取舍——宁可失败一次，也不重复执行一次非幂等请求。流式 body 的请求同样不重发，原始错误原样抛出。
- **旁路模式下卡片显示「旁路直连」并出现警示条**，与真实直连路径一致；切换旁路开关后自检不会复用旧结论。

### 验证与质量

- `npm run verify`：**507 个用例全绿**（v1.1.1 的 482 个 + 25 个新增回归用例），`typecheck` 0 错误，构建通过。
- 每条修复都先有失败用例：规则解析矩阵（`parseHostList` / `deadRuleEntries` / `decide` 三方一致）、RST 注入与调用方超时、流创建后 rebuild、旁路自检一致性、预设改名/删除与搜索绑定、半填凭据、尾点 IPv6、环境变量代理、`localhost.` 与 IPv4-mapped IPv6、粘贴清 TLS。
- `npm pack --dry-run`：仍为 **9 个文件**，包内容清单未变。

### 升级与迁移

无需手工迁移。配置字段与默认值未改动，备份文件版本不变（`version: 2`）。既有 `onlyHosts` / `bypassHosts` 中带全角逗号、尾点、连续点或 `.*` 的条目会在归一化后按新含义生效，设置页会列出这些条目；若希望保持 1.1.x 的旧行为，请在升级前改写这些规则。

### 安装

桌面版（先完整打开一次桌面版以初始化 profile，再完全退出）：
```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

Web 版：
```sh
dsh plugin --profile web add dsh-provider-proxy
```
