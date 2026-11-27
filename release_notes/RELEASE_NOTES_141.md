## v1.4.1 (Audit & Security Fixes)

v1.4.0 之后的补丁版本：首次包含 issue #1 的 `globalThis.fetch` accessor 兼容修复、一次全局审查确认的 7 项 HA / 重试 / 搜索 / UI 缺陷，以及 issue #2 的 Cordis peer 范围修正。

**npm 上没有发布过 1.4.0**，因此 npm 用户会从 1.3.0 直接升级到 1.4.1；从 GitHub tag 安装过 1.4.0 的用户也建议升级，以取得 accessor 修复与下述安全收紧。

### 修复

- **`globalThis.fetch` 为访问器属性时插件无法激活（#1）**：安装 fetch shim 改为构造纯 data descriptor，不再展开原 descriptor 后叠加 `value`。DSH 桌面运行时等以 get/set 暴露 fetch 的宿主可正常激活；`release()` 仍按安装前保存的原 descriptor 还原。
- **预设改名/删除未维护备用链引用**：`backupProfileIds` 现在随改名一并改写；删除预设的确认框会列出以它为备用节点的路由、预设与默认代理，并在同一次写入中清理引用，不再静默断链。
- **N29 对 502/503/504 重发非幂等请求**：5xx 重试仅限幂等方法（`GET` / `HEAD` / `OPTIONS` / `TRACE` / `PUT` / `DELETE`）。`POST` / `PATCH` 的 502/503/504 不再重试，避免上游已处理时重复生成或重复计费；连接建立阶段失败仍只按 body 可重放性判断。
- **搜索 `run` 作用域 claim 泄漏**：搜索 never-fetch、直连或 `bypassAll` 早退后，会在搜索 settle 时释放 dispatcher claim；rebuild 后旧 dispatcher 可正常关闭，不再累积 agent/socket。
- **`canReplayRequest` 忽略 Request 自带 body**：init 未提供 body 时回退检查 Request body，避免对 body 已被消费的 Request 重试或故障切换。
- **重复备用 ID 未去重**：新增共享 `uniqueBackupProfileIds`，config、预设、备份导入与建表统一 trim、去重、限长；重复 ID 只创建一个 dispatcher，界面与实际链路一致。
- **重试退避不响应调用方 AbortSignal**：退避等待与 abort 竞争，调用方超时后立即停止重试，不再多睡满 backoff。
- **不可重放请求的主节点故障未记录**：网络建连失败但 body 不可重放时仍标记主节点失败；后续请求（含流式上传）可在冷却期优先使用备用节点。
- **Cordis peer 范围（#2）**：`~4.0.4` → `>=4.0.4 <5.0.0-0 || >=4.2.0-alpha.1 <5.0.0-0`。显式命名 4.2.0 预发布元组，覆盖 DSH `0.2.3-alpha.2` 使用的 `@deepseek-ai/cordis@4.2.0-alpha.1`；npm 10/11 与 pnpm 11 实测可安装。

### 行为变化

- **5xx 重试范围收窄**：开启 `retryAttempts` 后，`POST` / `PATCH` 的 502/503/504 不再重试；幂等方法与连接建立阶段失败不受影响。README 与设置页提示已同步说明。
- 其余为缺陷修复，不改变正常路径的配置语义。

### 已知限制

- 宿主把 `fetch` 定义为 `configurable: false` 的访问器时仍无法安装 shim（平台限制）；`configurable: true` 的访问器已支持。
- 备用节点可达性仍不做主动探测；主节点返回 502/503/504 仍不触发备用切换（由 N29 处理，且仅幂等）。
- 重试预算仍按一次请求共享；未来 4.3.0-alpha 等预发布线需要新的 peer 子句。
- v4 备份仍会被 1.3.x 及更早版本拒绝；降级前请先保留旧版备份。

### 验证与质量

- `npm run verify`：**562 个用例全绿**，`typecheck` 0 错误，构建通过。
- `npm audit --omit=dev --audit-level=high`：0 漏洞（`undici 8.13.1`）。
- `npm pack --dry-run`：**9 个文件**，包版本为 `1.4.1`。
- 新增 11 条回归：预设引用改写/删除确认、幂等 5xx 判定、POST 502 不重试、never-fetch 搜索 claim 释放、Request + init 可重放判断、重复 ID 去重、abort during backoff、不可重放主节点记录。
- 实包安装验证：`dsh-provider-proxy-1.4.1.tgz` 与 `@deepseek-ai/cordis@4.2.0-alpha.1` 在 npm 10.9.3、npm 11.21.3、pnpm 11.22.0 下均无 peer 冲突。

### 升级与迁移

1. 升级前建议在桌面版或 `dsh web` 的备份页导出一份现有备份。
2. 配置字段无需手工迁移；1.4.0 的 v4 备份可继续导入，1.3.x 及更早版本会拒绝 v4 文件。
3. npm 1.4.0 从未发布；npm 用户从 1.3.0 直接升级到 1.4.1。
4. 若曾从 GitHub tag 安装 1.4.0，1.4.1 首次包含 #1 的 accessor 修复。

### 安装

桌面版（先完整打开一次桌面版以初始化 profile，再完全退出）：

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

Web 版：

```sh
dsh plugin --profile web add dsh-provider-proxy
```