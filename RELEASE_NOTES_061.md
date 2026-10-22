## v0.6.1

一次只修路由诊断语义的补丁版本：`lastUse` 现在绑定当前有效路由，不再把旧配置下的成功当成
现在的健康证明；自检缓存同时获得 TTL 与有界上限。无 schema 变更，0.6.0 配置无需迁移。

### 改了什么

- **「最近调用」绑定当前路由。** 每条路由获得一个全局单调递增、永不复用的 token。
  请求在绑定路由时捕获 token；只有 token 仍对应当前配置时，`onHit` / `onSettle` 才写
  `lastUse`。配置变更前启动的慢请求、配置变更后才开始消费的旧流，以及删除后同名重加的
  旧请求，都不能把结果写回新配置。
- **配置指纹覆盖真实路由输入。** 指纹包含实际生效的协议 / 主机 / 端口 / 用户名 / 密码、
  `onlyHosts` / `bypassHosts` 与 `localDirect`。域名规则按集合归一化：大小写、`.` / `*.`
  写法、顺序、重复项、空白和空项都不会造成无意义清空；规则集合真正变化才会清记录。
- **只清该清的东西。** 修改端点、默认端点（仅继承它的路由）、域名规则或 `localDirect`
  会清掉对应 provider 的 `lastUse`；`testUrl` / `testTarget` 不影响真实流量，不清记录；
  仅切换 `enabled` 保留记录。`hits` 是历史计数，始终保留。
- **配置更新串行化。** 每次 volatile update 只读取一次配置快照，并串行完成代理表构建、
  route state 决策与记录清理；连续编辑不会让较早的 rebuild 覆盖较新的结果。
- **自检缓存有界。** `lastChecks` 改为按 provider 分组：每次读取/写入清理过期条目，
  每个 provider 最多保留 8 条，全局最多 64 个 provider；超限时按最新 `at` 淘汰最久未更新
  的 provider。删除 provider 时同时清理缓存与在飞 pending，旧检查完成不会复活缓存。
- **诊断可见但不泄密。** `providerProxyState.selfCheckCache` 只暴露 provider 数、pending 数、
  总条目数、单 provider 最大条目数与过期条目数，不暴露 provider id、原始 key、密码或完整结果。

### 行为变化

- 改完端口、默认端点或域名规则后，该卡片的「最近成功」会变成「尚无代理记录」。
  这是刻意行为：这一行回答「这条路由现在是否还工作」，不是「历史上是否成功过」。
- 修改 `testUrl` / `testTarget` 不再清掉真实流量的「最近调用」记录。
- 关闭再打开同一路由不会清掉「最近调用」；删除 provider 再重新添加同名 provider 会视为新路由。
- `hits` 不会因上述配置变化而清零。

### 验证

- `npm run verify`：typecheck + build + 全部测试。
- 新增覆盖：规则指纹顺序/重复/空白/大小写/`.`/`*.` 等价性；端点、默认端点、域名规则、
  `localDirect`、`testTarget` 的清理边界；in-flight 旧请求与旧流不写回；删除后同名重加；
  `enabled` 切换保留记录；连续 volatile update 最终落在最后快照；
  `lastChecks` TTL、每 provider 8 条、全局 64 provider 上限、删除 provider 后缓存与 pending 清理。
- **2026-10-22 DSH Desktop 手工冒烟**：`deepseek-account / DeepSeek-V4.1-Flash 1017`
  经 `127.0.0.1:17891` 测试隧道请求 `api.deepseek.com:443`，回复 `OK`（1 秒）；
  Host catalog 同时返回 `hits.deepseek-account = 1` 与
  `lastUse = { ok: true, code: "200" }`。测试后配置已还原，测试代理已停止。
- **手工冒烟边界**：本机设置面板入口本次未稳定打开，卡片文案未作为手工通过项；
  卡片渲染由 `tests/client.test.ts` 覆盖，路由清理与旧请求隔离由 `npm run verify` 的
  网络集成测试覆盖。

### 升级

无字段迁移。0.6.0 的 `cordis.patch.yml` 可直接使用。升级后如果改了端点或路由规则，
卡片显示「尚无代理记录」属于预期行为，不是计数或历史数据丢失。

### 安装

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```
