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
dsh plugin --profile desktop add D:\gitwork\dsh-provider-proxy
```

Web：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-provider-proxy
```

安装后重启对应应用。设置项写在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。

## 使用

打开 **设置**，左侧导航里会出现一项 **Provider 代理**（英文界面为 *Provider Proxy*）。
页面里每个 provider 一张卡片，各自独立配置：

| 字段 | 说明 |
| --- | --- |
| 开关 | 该 provider 是否走代理 |
| 类型 | `HTTP` / `HTTPS`（`SOCKS5` 目前未实现，选它会给出提示） |
| IP / 主机 | 只填主机名或 IP，不要带 `http://` 或路径 |
| 端口 | 1–65535 的整数 |
| 用户名 | 可选 |

列表只包含**已激活**的 provider（`llm.listProviders()` 能列出的那些）。仅在配置里声明、
但没有实际注册的可配置 provider 不显示——它的请求根本不会被发出去。
已经在 `providers` 里配过代理的条目即使暂时不激活也仍然保留，避免已保存的设置悄悄消失。

保存立即对新请求生效，不需要重启；正在进行中的流会继续用它启动时的那条连接。

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

- **SOCKS5 未实现。** `undici` 的 `ProxyAgent` 只会用 HTTP CONNECT 连 HTTP 代理，对 SOCKS5 需要另写连接器。界面里会明确提示，而不是悄悄按 HTTP 路由。
- **上游若绕过 `globalThis.fetch` 自行建连，则不受影响。** `llm-deepseek` 确认是调用时解析全局 `fetch`；`llm-pi-ai` 走外部 SDK，抓取 `fetch` 的时机未能在源码层面确证。
- **不支持 PAC**，也不读取系统代理设置。
- **不改写 `baseURL`** —— 反向代理/中转请直接在 provider 上配置。
- **代理不可达时**请求照常失败，DSH 既有的重试与错误码语义不变。
- 代理密码不进 `cordis.patch.yml`：配置里只存凭据引用名，密码本身走 credentials 服务。
- **代理用户名可用，密码尚未接入。** `passwordRef` 字段已预留并默认留空，UI 上只提供用户名输入框。

## 如何验证代理确实生效

插件本身不显示出口 IP。可靠的判断方式是在代理端看日志，或临时把端口改成
一个没人监听的端口——如果请求失败并报 `ECONNREFUSED 127.0.0.1:<该端口>`，
就说明请求确实是被代理承载的（直连时报错会指向目标站点）。

仓库里的 `tests/proxy-routing-proof.test.ts` 就是用这个思路做的：起一个会记录
连接的假代理，断言「启用的路由收到 1 次连接、未配置的 provider 收到 0 次」。

## 开发

```sh
npm run build      # 构建 lib/index.js 与 lib/client.js
npm test           # 69 个用例，跑的是构建产物
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
