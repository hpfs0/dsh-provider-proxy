## v0.2.1

修复插件市场的跳转链接指向了错误的仓库。

### 问题

在 DSH 插件市场里点击安装 `dsh-provider-proxy` 后，「查看源码」链接指向的是

```
https://github.com/stayhpjinng/dsh-provider-proxy
```

而不是本项目 `https://github.com/hpfs0/dsh-provider-proxy`。

**实际安装的插件内容是正确的**（来自 npm 上的 tarball），只有展示链接是错的。

### 原因

`package.json` 里没有 `repository` 字段，npm 上也就没有仓库地址。插件市场找不到仓库信息时，会**按包名去猜** GitHub 链接——而 `dsh-provider-proxy` 这个名字下，先注册的是另一个人的同名仓库，正是上面那个链接。

### 修复

补上了仓库元数据：

```json
"repository": { "type": "git", "url": "git+https://github.com/hpfs0/dsh-provider-proxy.git" },
"homepage": "https://github.com/hpfs0/dsh-provider-proxy#readme",
"bugs": { "url": "https://github.com/hpfs0/dsh-provider-proxy/issues" }
```

并新增回归测试 `the package declares where its source lives`，防止再次遗漏。

> npm 的包元数据按版本不可变，因此 `0.2.0` 无法补写，必须发布新版本才能纠正链接。

### 安装

```sh
dsh plugin --profile desktop add dsh-provider-proxy
```

完整说明见 [README](https://github.com/hpfs0/dsh-provider-proxy#readme)。

### 验证

- 70 个用例通过
- 全新安装冒烟测试通过（从公共 npm 源安装后可正常加载）