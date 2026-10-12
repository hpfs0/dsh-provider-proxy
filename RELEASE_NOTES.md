## 首次发布

给 **DeepSeek Harness**（`0.2.0-rc.1` 及以上）用的插件：在 **设置** 里为每个 provider 单独配置「这个 provider 要不要走代理」，填写代理类型 + IP/端口。只有被你打开开关的 provider 走代理，其余 provider 和 DSH 的其它流量保持原来的直连路径。

支持官方桌面版（DSH Desktop）与 `dsh web`。

### 安装

桌面版（**必须先完整打开一次桌面版以初始化 profile，然后完全退出**，否则安装命令会拒绝执行）：

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

Web：

```sh
dsh plugin --profile web add dsh-provider-proxy
```

安装后重启对应应用。

### 使用

打开 **设置**，左侧导航会出现 **Provider 代理**。每个 provider 一张卡片，各自独立配置：

| 字段 | 说明 |
| --- | --- |
| 开关 | 该 provider 是否走代理 |
| 类型 | `HTTP` / `HTTPS`（`SOCKS5` 目前未实现，选它会给出提示） |
| IP / 主机 | 只填主机名或 IP，不要带 `http://` 或路径 |
| 端口 | 1–65535 的整数 |
| 用户名 | 可选 |

列表只显示**已激活**的 provider（`llm.listProviders()` 能列出的那些）。已经在 `providers` 里配过代理的条目即使暂时不激活也仍然保留，避免已保存的设置悄悄消失。

保存立即对新请求生效，不需要重启；正在进行中的流会继续用它启动时的那条连接。

### 它是怎么工作的

0.2.0 没有「给单个 provider 注入 transport」的官方口子（已逐条核对 `llm-deepseek` / `llm-pi-ai` / `LlmCallControls` / `llm/stream` / `ctx.web` / `dsh-http-proxy`）。

所以请求在唯一还能拿到 provider 线索的地方被路由：`llm/stream` waterfall 的 `options.provider`。用一个 `AsyncLocalStorage` 把该 provider 专属的 dispatcher 带到流上，再由一层很薄的 `globalThis.fetch` 包装把它交给 fetch。

两个关键点：

1. **每个 provider 各自持有一个 dispatcher**（而不是共用一个），所以即使两个 provider 指向同一个上游主机，也不可能互相串用对方的代理。
2. **流的惰性消费必须被处理**：adapter 的 HTTP 调用通常发生在后续的 `next()` 里，那时 `als.run()` 早已返回。所以每次迭代器的 `next/return/throw` 都会被重新包进作用域里。

代价是这一个全局 `fetch` 包装：作用域之外的行为与原生完全一致，作用域之内若调用方已经自带 `dispatcher` 也不会被覆盖。

> **为什么是独立设置页，而不是内嵌在 Models 的 provider 卡片里？**
> 本插件最早按卡片内嵌（`settings.models.provider-card`）实现，但那个槽位是 keyed 的、按 provider 命名空间派发，第三方注册在 0.2.0-rc.1 上始终匹配不上——不报错、不发请求、界面上什么都不出现。独立分区（`settings.section`）是同一 profile 下 `dsh-llm-retry-settings` 已被验证可用的机制。

### 如何确认代理真的生效

插件本身不显示出口 IP。可靠办法是在代理端看日志，或临时把端口改成一个没人监听的端口——如果请求失败并报 `ECONNREFUSED 127.0.0.1:<该端口>`，就说明请求确实被代理承载了（直连时报错会指向目标站点）。

### 已知限制

- **SOCKS5 未实现。** `undici` 的 `ProxyAgent` 只会用 HTTP CONNECT 连 HTTP 代理，对 SOCKS5 需要另写连接器。界面里会明确提示，而不是悄悄按 HTTP 路由。
- **代理密码尚未接入。** 用户名可用，密码需手动写入 `passwordRef` 指向的凭据记录。
- **上游若绕过 `globalThis.fetch` 自行建连，则不受影响。** `llm-deepseek` 确认是调用时解析全局 `fetch`；`llm-pi-ai` 走外部 SDK，抓取 `fetch` 的时机未能在源码层面确证。
- **不支持 PAC**，也不读取系统代理设置。
- **不改写 `baseURL`** —— 反向代理/中转请直接在 provider 上配置。
- **仅在 `0.2.0-rc.1` 上验证过**，`0.2.0-rc.2` 未实测。

### 兼容性

`engines.dsh` 声明为 `>=0.2.0-rc.1 <0.3.0`。上界刻意保守，方便后续跟随上游小版本变化调整。