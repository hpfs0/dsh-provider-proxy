## v1.1.0 (Advanced Extensions)

深度增强与进阶扩展：**后台定时轻量心跳监测与失联预警 (Heartbeat)**、**搜索 / 推理流量分离代理 (Traffic Split)**、**SOCKS5 over TLS (Proxy TLS)**，外加设置页**页签化**与一轮无障碍 (a11y) 封顶。

基于 `v1.0.0 (GA)` 基线，**0.8.0 / 0.9.0 / 1.0.0 的配置无需任何迁移**：新字段一律按安全默认值补齐，旧备份文件也能直接导入。

### 改了什么

- **SOCKS5 over TLS / Proxy TLS (N22)。**
  协议选 `SOCKS5` 时，卡片与预设表单会展开「**启用 TLS 加密隧道**」开关；打开后再展开「允许自签名证书」（附安全警示框）。
  - 底层直接用 `undici` 的 `Socks5ProxyAgent` 原生 `options.proxyTls`，**不引入任何新依赖**；
  - 开启后端点显示为 `socks5s://host:port`，诊断、卡片与紧凑行一眼可见 TLS 是否生效；
  - 粘贴 `socks5s://` 或 `socks5+tls://` 开头的地址会自动识别为 SOCKS5 + TLS；
  - `proxyTls` 与 `proxyTlsRejectUnauthorized` 参与路由指纹，切换开关会立即重建 dispatcher。
  - 默认 **严格校验证书**（`proxyTlsRejectUnauthorized: true`）。
- **后台定时轻量心跳监测与失联预警 (N23)。**
  新增全局设置 `heartbeatEnabled`（默认 **`false`**，坚持零额外流量原则）、`heartbeatInterval`（60 / 300 / 900 / 1800 秒）、`heartbeatConsecutiveFails`（默认 2）。
  - 只发轻量探测，provider 之间打散抖动、并发受限，不会整点冲峰；计时器由插件生命周期持有，注销即销毁；
  - 连续失败达阈值即标记 **失联**：仪表盘脉冲点转红、顶部失联预警横幅、卡片与紧凑行打上 `心跳失联 (ECONNREFUSED)` 标签并显示上次成功时间；
  - 未达阈值前先显示黄色 `探测异常 N/M`，不必等满阈值才发现问题；代理恢复后下一次探测即自愈；
  - 关闭开关只停止探测，不抹掉已有记录（记录也不再渲染）。
- **搜索 / 推理流量分离代理与独立分流路由 (N24)。**
  新增全局设置 `searchProxyStrategy`（`inherit` 默认 / `dedicated` / `direct` / `custom`）与 `searchProxyProfileId`。
  - `ctx.web.search` 逐次调用解析链路：保留的 `web-search` 卡片 / 由预设派生的**独立 dispatcher** / 原生直连；
  - `dedicated` 绑定的预设被删除或配置不完整时**拒绝搜索请求**，绝不悄悄改走直连——悄悄直连会把搜索的真实出口暴露在用户特意绕开的网络上；
  - `RouterScope` 增加 `trafficType`（`reasoning` / `search`），规则可区分两类流量；
  - 仪表盘「累计转发请求量」拆成 `推理 N · 搜索 M（直连 K）`，卡片与「最近调用」行标注 `[推理]` / `[搜索]`；
  - `web-search` 卡片显示当前搜索链路徽标（跟随本卡片 / 独立搜索代理 / 直连 / 搜索被拒绝）。
- **设置页页签化。**
  由长滚动单页改为 **Provider 列表 / 代理预设 / 全局设置 / 备份与恢复** 四个页签；仪表盘与底部「连接诊断」留在页签之外（它们是整机状态，不是设置项）。非活动面板用 `hidden` 而不是卸载，草稿、自检结果与筛选条件不会因切换页签丢失；页签选择记入查看偏好，重开设置页回到上次那一页。
- **备份 Schema v2 与跨版本兼容 (N25)。**
  备份文档升级到 `version: 2`，新增 `heartbeatEnabled` / `heartbeatInterval` / `heartbeatConsecutiveFails` 与 `searchProxyStrategy` / `searchProxyProfileId`；`proxyTls` 两个标志随每个端点序列化。
  - **0.8.0**（无 `version`、无 `proxyProfiles`）、**1.0.0**（`version: 1`）、**1.1.0**（`version: 2`）三种文件都能直接导入；缺失段按当前安全默认补齐；
  - 来自**更新版本**的文件（`version > 2`）会明确拒绝，而不是半途覆盖；
  - 恢复仍是**一次写入**覆盖全部十段，rev 冲突整体失败，不会留下半套配置。
- **无障碍 (a11y) 封顶 (N25)。**
  - 搜索分流策略由下拉改为 `role="radiogroup"` 单选组（四个选项常驻可见，单一 Tab 停点 + 方向键），补齐 `aria-labelledby` / `aria-describedby`；解析结果行 `role="status"`，配置失效时 `role="alert"`；
  - **修复键盘可达性缺陷**：恢复配置的文件选择器原为 `display: none`（Tab 永远到不了），改为可聚焦的裁剪方案并补 `aria-label`；
  - 全局开关与各自的说明文字用 `aria-describedby` 关联；页签补齐 `role="tablist" / tab / tabpanel` 与 `aria-selected` / `aria-controls`；
  - 新增**全页无障碍不变量**用例：任何表单控件都必须有可访问名称、任何按钮都必须有名字、任何 aria 引用都必须能解析到真实存在的 id。

### 行为变化

- **默认值仍是安全的那一侧**：`heartbeatEnabled` 默认关闭（不产生任何未经许可的后台外呼），`proxyTlsRejectUnauthorized` 默认开启（杜绝中间人劫持），搜索分流默认 `inherit`（与 1.0.0 行为完全一致）。
- **搜索分流是 fail-closed 的**：`dedicated` 绑定失效时搜索**报错**而不是直连。要恢复搜索，改绑定或把策略切回「继承」。
- **恢复备份会整体替换全局设置**：包括心跳与分流五个字段。不这样做的话，文件里没有的开关会沿用还原前的状态，恢复结果就取决于上一个状态而不是文件。
- **脱敏范围扩大**：脱敏覆盖**每一种**端点形态（卡片 / 预设 / 默认代理 / 新增 TLS 端点），`proxyTls` 等配置项保留、仅密码置空。
- **心跳与分流字段的改动不会清空自检结果**：它们只改变「探测」与「搜索」的路由，卡片自检的答案仍然有效。

### 验证与质量

- `npm run verify`：全部 **472 个用例全绿通过**（0.8.0/1.0.0/1.1.0 备份跨版本导入与版本拒绝、SOCKS5-TLS 端点脱敏、心跳阈值流转与自愈、搜索/推理双代理端到端隔离、`dedicated` 失效拒绝、页签 ARIA 与持久化、全页无障碍不变量等）。
- `npm run typecheck`：TypeScript 0 错误。
- **零新增运行时依赖**：TLS 走 `undici` 内置能力，无新增第三方包。

### 升级与迁移

无需迁移。`cordis.patch.yml` 会自动按 Schema 默认值补齐 `heartbeatEnabled: false`、`heartbeatInterval: 300`、`heartbeatConsecutiveFails: 2`、`searchProxyStrategy: 'inherit'`、`searchProxyProfileId: ''`，既有配置原样即用。旧备份文件（含 0.8.0）可直接导入。

### 安装

桌面版：
```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

Web 版：
```sh
dsh plugin --profile web add dsh-provider-proxy
```
