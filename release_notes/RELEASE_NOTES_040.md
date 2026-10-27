## v0.4.0

在 0.3.0 的 per-provider 代理之上补齐五项能力：HTTP/HTTPS 代理密码、连接自检、经代理的请求计数、按目标域名规则路由，以及让 `web_search` 也走代理。

### 改了什么

- **HTTP/HTTPS 也支持密码。** 此前密码只对 SOCKS5 生效，HTTP/HTTPS 仅支持用户名。现在三种协议的密码字段都可用：HTTP/HTTPS 把 `user:pass` 放进代理 URL 的 userinfo，由 undici 的 `ProxyAgent` 生成 `Proxy-Authorization`；SOCKS5 仍把密码作为选项传给 `Socks5ProxyAgent`。顺带修正了 `proxyUrl()` 中把 `%3A` 还原成字面 `:` 的旧行为——字面冒号会让 WHATWG 在第一个冒号处切分 userinfo，含冒号的用户名会被误读。
- **连接自检。** 每张卡片（该 provider 已启用代理时）多一个 **测试** 按钮：Host 通过**该 provider 自己的代理**发一次请求，回报延迟与（探测目标返回时）出口 IP。延迟数值按快慢着色——≤500 ms 绿、≤1500 ms 黄、更慢红，数值始终照常显示。探测目标由顶层设置 `testUrl` 配置，默认是回显服务。
- **请求计数。** 设置页显示该 provider「已代理 N 次」，用于确认策略确实生效，不必再靠改端口试错。计数在请求发起时累加，保存在代理表之外，改设置触发的 rebuild 不会清零。
- **目标域名规则（fail-closed）。** 每个 provider 新增 `onlyHosts` / `bypassHosts`（逗号或空格分隔、后缀匹配、`*` 表示全部、大小写不敏感）。启用了代理的路由默认走代理，只有「`bypassHosts` 命中」与「`onlyHosts` 非空且未命中」两种显式例外才直连；解析不出目标主机时**仍走代理**，避免畸形 URL 把带凭据的请求悄悄直连出去。
- **`web_search` 走代理。** 搜索 provider（`dsh-web-search-deepseek`）用全局 `fetch`，插件通过包裹 `ctx.web.search` 把它送进代理作用域。保留 id `web-search` 挂在 `providers` 字典里，设置页出现一张 **Web 搜索** 卡片，复用卡片渲染、保存路径、计数与域名规则。

### 安全口径

- 代理密码仍以明文随设置写入 `cordis.patch.yml`。HTTP/HTTPS 的密码会拼进交给 `undici` 的代理 URL，SOCKS5 的密码只作为选项传给 `Socks5ProxyAgent`；两者都不会出现在日志或诊断里的代理 URL——那里只显示不含凭据的 origin。
- 认证字段成对：SOCKS5 填了用户名必须填密码，HTTP/HTTPS 填了密码必须填用户名。不合规则的配置会被拒绝并在「连接诊断」里说明，而不是静默忽略或降级。
- 域名规则默认 fail-closed：仅两种显式例外才直连。
- 自检端点只接受 `POST`，provider 必须命中当前生效的表，且同一 provider 在飞去重——不会被当成外呼放大器。错误按 cause 链分类为「代理不可达 / 认证失败(407) / 超时 / 目标失败」，避免把诊断指向错误的环节。

### 已知限制

- **`web_fetch` 不能走代理。** 它用 `undici` 自带的 `dispatcher`（来自官方的进程级 env 策略），没有 per-provider 注入点；需要覆盖它请改用 `HTTP_PROXY` 之类的环境变量。
- **`web_search` 的覆盖有前提**：工具每次调用都重新取 `ctx.web.search`，且 provider 的 `search()` 是 await-to-completion（不是惰性消费的流）。
- **`bypassHosts` 命中时由本机解析并连接目标**（DNS 不经过代理）。SOCKS5 下这一点后果最明显。
- **保留 id `web-search`。** 真实 provider 若恰好撞名，会与该路由共用同一份配置（无害）。
- **连接自检依赖 `testUrl` 可达。** 默认回显主机在部分网络下可能不可达，会让自检误报失败，请换成自建回显服务。

### 兼容性

- 新字段（`onlyHosts`、`bypassHosts`、顶层 `testUrl`）都带默认值，**旧配置无需迁移**；不配置时行为与 0.3.0 完全一致。
- `web-search` 是新增的保留 id；未启用时搜索保持直连。

### 验证

- 110 个用例通过（`npm run verify`：typecheck + build + test）。

### 安装

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

完整说明见 [README](https://github.com/hpfs0/dsh-provider-proxy#readme)。
