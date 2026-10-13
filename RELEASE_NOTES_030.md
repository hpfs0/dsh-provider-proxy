## v0.3.0

SOCKS5 的认证在设置页里真正可用了：新增「密码」输入框，并移除旧的 `passwordRef`（密码凭据名）机制。

### 改了什么

- **设置页新增「密码」字段**，仅在类型选 `SOCKS5` 时出现。此前发布的 0.2.1 里，选中 SOCKS5 时界面显示「SOCKS5 尚未实现」，且没有任何凭据输入项——本次把 SOCKS5 的整条认证路径（用户名 + 密码）在界面上开放出来。
- **移除 `passwordRef`**。密码不再指向 credentials 服务里的凭据记录，而是作为路由自身的字段 `password` 直接保存。`src/index.ts` 里的凭据解析（`resolveProxyPassword`、记录作用域）随之删除。
- **「用户名必须与密码同时填写」的守卫保留**：SOCKS5 只填用户名会被拒绝并提示，而不是静默降级为无认证。

### 安全口径

代理密码现在以明文随设置写入 `cordis.patch.yml`。它只会作为选项传给 `undici` 的 `Socks5ProxyAgent`，不会拼进代理 URL，因此不出现在日志和「连接诊断」里。HTTP/HTTPS 代理仍只支持用户名，密码只对 SOCKS5 生效。

### 兼容性

从 0.2.x 升级无需手动清理：老配置里若残留 `passwordRef` 键会被忽略（惰性，不影响加载与运行），实际认证只读 `password` 字段。

### 验证

- 82 个用例通过（`npm run verify`：typecheck + build + test）。
- 端到端 SOCKS5 用例（`tests/e2e-socks5.test.ts`）起了真实的 RFC 1928 / RFC 1929 服务器，断言代理端收到了用户名 `alice` 与密码 `hunter2`，且隧道内完成了到 `.invalid` 目标的寻址。

### 安装

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

完整说明见 [README](https://github.com/hpfs0/dsh-provider-proxy#readme)。
