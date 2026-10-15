# dsh-provider-proxy [![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

给 **DeepSeek Harness**（`0.2.0-rc.1` 及以上）用的插件：在 **设置** 里为**每个 provider 单独配置**「这个 provider 要不要走代理」，填写代理类型 + IP/端口。只有被你打开开关的 provider 走代理，其余 provider 和 DSH 的其它流量保持原来的直连路径。

支持官方桌面版（DSH Desktop）与 `dsh web`。

## 安装

先确保已构建过产物（`lib/index.js`、`lib/client.js`）：

```sh
npm install
npm run build
```

桌面版（**必须先完整打开一次桌面版以初始化 profile，然后完全退出**，否则安装命令会拒绝执行）：

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

Web：

```sh
dsh plugin --profile web add dsh-provider-proxy
```

安装后重启对应应用。设置项写在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。

## 使用

打开 **设置**，左侧导航里会出现一项 **Provider 代理**（英文界面为 *Provider Proxy*）。
页面里每个 provider 一张卡片，各自独立配置：

| 字段 | 说明 |
| --- | --- |
| 开关 | 该 provider 是否走代理 |
| 类型 | `HTTP` / `HTTPS` / `SOCKS5` |
| IP / 主机 | 只填主机名或 IP，不要带 `http://` 或路径 |
| 端口 | 1–65535 的整数 |
| 用户名 | 可选 |
| 密码 | 可选。作为代理认证口令发给代理（`HTTP` / `HTTPS` / `SOCKS5` 均支持） |

列表只包含**已激活**的 provider（`llm.listProviders()` 能列出的那些）。仅在配置里声明、
但没有实际注册的可配置 provider 不显示——它的请求根本不会被发出去。
已经在 `providers` 里配过代理的条目即使暂时不激活也仍然保留，避免已保存的设置悄悄消失。

保存立即对新请求生效，不需要重启；正在进行中的流会继续用它启动时的那条连接。

每张卡片在**该 provider 已启用代理**时还有一个 **测试** 按钮：点它会让 Host 通过**该 provider 自己的代理**发一次请求，回报延迟与（探测目标返回时）出口 IP。探测目标默认是 `https://api.ipify.org?format=json`，可用顶层设置 `testUrl` 换成自建的回显服务。代理不可达时它会明确失败，而不是假通过。

卡片里还有一个折叠的 **高级：目标域名规则**，按**目标主机**决定是否走代理：

| 字段 | 说明 |
| --- | --- |
| `仅走代理`（`onlyHosts`） | 逗号或空格分隔。非空时，只有匹配这些主机的请求走代理，其余直连。 |
| `直连`（`bypassHosts`） | 逗号或空格分隔。匹配这些主机的请求直连，优先于 `onlyHosts`。 |

两者都按后缀匹配（`example.com` 覆盖 `api.example.com`），`*` 表示全部，大小写不敏感。**默认是 fail-closed**：启用了代理的路由默认走代理，只有「`bypassHosts` 命中」与「`onlyHosts` 非空且未命中」两种显式例外才直连；解析不出目标主机时**仍走代理**，避免畸形 URL 把带凭据的请求悄悄直连出去。

> **为什么是独立设置页，而不是内嵌在 Models 的 provider 卡片里？**
> 本插件最早按卡片内嵌（`settings.models.provider-card`）实现，但那个槽位是 keyed 的、
> 按 provider 命名空间派发，第三方注册在 0.2.0-rc.1 上始终匹配不上——不报错、不发请求、
> 界面上什么都不出现。独立分区（`settings.section`）是同一 profile 下
> `dsh-llm-retry-settings` 已被验证可用的机制。

## 它是怎么工作的

0.2.0 没有「给单个 provider 注入 transport」的官方口子，这是核对过源码的结论：

- `llm-deepseek` 直接调用全局 `fetch`，请求参数里没有 `dispatcher`；
- `llm-pi-ai` 走 pi-ai SDK 自己的 HTTP，DSH 无法配置；
- `LlmCallControls` 只有 `reasoningEffort` / `temperature` / `maxTokens` / `stop`；
- `llm/stream` 拦截的是**已解码的** `StreamChunk`，发生在 HTTP 之后；
- `ctx.web` 只服务 `web_search` / `web_fetch`，与 provider 流量无关；
- 官方的 `@deepseek-ai/dsh-http-proxy` 是**库**不是插件：`installGlobalProxy` 是模块私有函数，没有 service、没有 Config、只有从环境变量解析出的一份进程级策略。

所以请求在唯一还能拿到线索的地方被路由：`llm/stream` waterfall 的 `options.provider`。用一个 `AsyncLocalStorage` 把选中的 dispatcher 带到流上，再由一层很薄的 `globalThis.fetch` 包装把它交给 fetch。

两个关键点：

1. **每个 provider 各自持有一个 dispatcher**（而不是共用一个），所以即使两个 provider 指向同一个上游主机，也不可能互相串用对方的代理。
2. **流的惰性消费必须被处理**：adapter 的 HTTP 调用通常发生在后续的 `next()` 里，那时 `als.run()` 早已返回。所以每次迭代器的 `next/return/throw` 都会被重新包进作用域里 —— 这正是旧版实现在这里踩过的坑，仓库里有对应的回归测试。

代价是这一个全局 `fetch` 包装：作用域之外的行为与原生完全一致，作用域之内若调用方已经自带 `dispatcher` 也不会被覆盖。

## 已知限制

- **SOCKS5 由 `undici` 内置的 `Socks5ProxyAgent` 实现**（RFC 1928 / RFC 1929），API 稳定性标记为 *Experimental*；`undici` 若在未来移除，需要同步调整。
- **代理认证字段的成对规则。** SOCKS5 下填了用户名就必须填密码（`Socks5ProxyAgent` 只在两者齐备时才发起认证；只填用户名会被拒绝并给出提示，而不是静默降级为无认证）；HTTP/HTTPS 下填了密码就必须填用户名（基本认证无法只发密码）。不合规则的配置会被拒绝并在「连接诊断」里说明，而不是被静默忽略——否则在强制认证的代理端，报错会指向代理而真正原因是设置缺项。HTTP/HTTPS 下只填用户名仍照常工作。
- **SOCKS5 不支持 `socks://` 别名与 SOCKS5 over TLS**（`proxyTls`）。
- **`bypassHosts` 命中时由本机解析并连接目标**（DNS 不经过代理）。SOCKS5 下这一点后果最明显：命中的域名不再由代理端解析，本机 DNS 会暴露该次查询。
- **上游若绕过 `globalThis.fetch` 自行建连，则不受影响。** `llm-deepseek` 确认是调用时解析全局 `fetch`；`llm-pi-ai` 走外部 SDK，抓取 `fetch` 的时机未能在源码层面确证。
- **不支持 PAC**，也不读取系统代理设置。
- **不改写 `baseURL`** —— 反向代理/中转请直接在 provider 上配置。
- **代理不可达时**请求照常失败，DSH 既有的重试与错误码语义不变。
- **连接自检依赖 `testUrl` 可达。** 默认的回显主机在部分网络下可能不可达，会让自检误报失败；请通过 `testUrl` 换成自建回显服务。自检只接受 `POST`，同一 provider 的多次点击会共享同一次在飞请求，不会被当成外呼放大器。
- **代理密码以明文随设置写入 `cordis.patch.yml`。** HTTP/HTTPS 的密码会拼进交给 `undici` 的代理 URL（`ProxyAgent` 由此生成 `Proxy-Authorization`），SOCKS5 的密码只作为选项传给 `Socks5ProxyAgent`；两者都不会出现在日志或诊断里的代理 URL——那里只显示不含凭据的 origin。

## 如何验证代理确实生效

插件本身不显示出口 IP。可靠的判断方式是在代理端看日志，或临时把端口改成
一个没人监听的端口——如果请求失败并报 `ECONNREFUSED 127.0.0.1:<该端口>`，
就说明请求确实是被代理承载的（直连时报错会指向目标站点）。

仓库里的 `tests/proxy-routing-proof.test.ts` 就是用这个思路做的：起一个会记录
连接的假代理，断言「启用的路由收到 1 次连接、未配置的 provider 收到 0 次」。

## 开发

```sh
npm run build      # 构建 lib/index.js 与 lib/client.js
npm test           # 82 个用例，跑的是构建产物
npm run typecheck  # 类型检查（仅覆盖 src/）
npm run verify     # 上面三件事，按顺序
```

`lib/` 是构建产物，不入库；包上的 `prepare` 脚本会在 `npm publish` 以及从 git
地址安装时自动重建。直接 `dsh plugin add <克隆目录>` 前请先执行
`npm install && npm run build`。

浏览器半必须输出 client module system 的 lazy-CJS factory 格式（脚本本身只注册工厂，所有副作用都在工厂闭包里执行），`scripts/build.mjs` 负责这件事，格式与 DSH 自带插件一致。

## 发布

```sh
npm run verify          # 先确认全绿
npm version patch       # 0.2.0 -> 0.2.1
npm publish
git push --follow-tags
```
