# 编写 ygl-trees 用户插件（spec R14 L3）

业务域扩展 ygl-trees 的标准方式——**不改源码，装插件**。模式取自 DSH apps/cli 的应用典范
（profile + 用户层 bundle + 逐插件隔离加载 + 诊断落盘）。

## 一分钟上手

```bash
# 1. 写插件（一个普通 npm 包，两个可选导出）
mkdir my-domain-plugin && cd my-domain-plugin
cat > package.json <<'EOF'
{ "name": "my-domain-plugin", "version": "0.1.0", "main": "index.js" }
EOF
cat > index.js <<'EOF'
exports.apply = (ctx, config) => { /* Cordis 插件体：注册 Service、接线事件 */ };
exports.commands = {
  mydom: { run: (env, action, rest, args) => { console.log("hello 业务域"); return 0; } },
};
EOF

# 2. 装进工作区（本地目录自动 link:，npm 包/git 地址直装）
ygl-trees plugin install ./my-domain-plugin        # 或 npm 包名 / git url

# 3. 用
ygl-trees mydom            # 插件贡献的命令组即刻可达
ygl-trees plugin list      # 版本 / spec / 可解析态
ygl-trees doctor           # 第 9 项 profile_integrity 护航
```

完整可跑示例见 [examples/plugin-demo](../examples/plugin-demo)（demo 组 12 回归锁定）。

### 给插件传配置 / 临时停用

```bash
ygl-trees plugin config my-domain-plugin '{"greeting":"你好","limit":5}'   # apply(ctx, config) 收到它
ygl-trees plugin config my-domain-plugin                                  # 查看当前 config
ygl-trees plugin config my-domain-plugin --clear                          # 清空
ygl-trees plugin disable my-domain-plugin     # 保留安装，启动时不挂载（命令组随之消失）
ygl-trees plugin enable  my-domain-plugin
ygl-trees plugin list                         # state（启用/停用）+ cfg（有/—）两列
```

`$YGL_HOME/ygl.user.bundle.json` 的条目形如：

```json
{ "plugins": [ { "name": "my-domain-plugin", "spec": "link:/abs/path",
                 "config": { "greeting": "你好" }, "enabled": true } ] }
```

`enabled: false` 与卸载的区别：**条目留在 bundle**（重启用无需重装）；`config` 省略时 `apply` 收到 `{}`。
这两个字段对标 Cordis loader 的 Entry options（`config` / `disabled`）——采纳其**能力**，不引入 loader 机制（理由见 [vendor/README.md](../vendor/README.md) 的 loader 裁决）。

## 插件契约

| 导出 | 必填 | 语义 |
|---|---|---|
| `apply(ctx, config)` | 否 | Cordis 插件体。可用服务：`ctx.database.db`、`ctx.research.store`、`ctx.techtree.trees`、`ctx.webApp` |
| `commands` | 否 | `{ <组名>: { run(env, action, rest, args) → rc } }`——贡献 CLI 命令组；dispatch 顺序：插件命令 → 内建 DOMAIN_ROUTES → unknown |
| `package.json` 的 `yglTrees` | 否 | 兼容声明（如 `"^0.36"`）；主版本不符启动时 stderr 警告（不拒绝） |

安全模型：插件代码以进程全权限运行——**只装你信任的包**（与 DSH profile 同语义）。

## 结构（DSH 典范的 ygl-trees 缩放版）

```
$YGL_HOME/
  plugins/                      # pnpm 管理的 profile（package.json + node_modules）
    package.json                # ygl-user-plugins（plugin init 创建，幂等）
    node_modules/<插件…>
  ygl.user.bundle.json          # 用户层声明：装哪些插件（install/remove 自动维护）
repo-root/
  ygl.bundle.json               # base 组合：database → research → techtree → web-app
```

启动加载序：base bundle → user bundle（用户层补丁叠在 base 上，DSH user-layer 对应物）。
逐插件隔离：一个插件加载失败不影响其余，汇总进 **StartupError** → 终端简洁摘要 +
完整报告落盘 `$YGL_HOME/logs/startup-<uuid>.log`（含凭证泄漏警告，分享前自查）。

## 工程细节（与 DSH apps/cli 对齐的部分）

- **安装锁**：install/remove 在 `withFileLock(profile/package.json)` 内执行
  （`@deepseek-ai/dsh-atomic-write`，与 `dsh plugin` 同一原语）
- **名字解析**：安装后名 = pnpm 前后依赖键**差集**（精确，无启发式猜测）
- **包管理器注入**：`YGL_PACKAGE_MANAGER` 环境变量可整体替换（installation-owned，
  嵌入式/离线载体无需改码）；Windows 下 `.cmd` shim 走 shell 解析
- **停机**：`createProcessShutdown`（DSH process-shutdown 对应物）——正常停机幂等合并、
  信号重复触发升级强杀、5s 宽限、dispose 失败也强制退出

## 故障排查

| 症状 | 处置 |
|---|---|
| `plugin list` 显示 ✗ 不可解析 | `plugin remove <name>` 后重装；或 `doctor` 看 plugin_profile 项 |
| 启动报 "N plugin issue(s) during startup" | 读终端给出的 report 路径（`$YGL_HOME/logs/startup-*.log`） |
| 装了命令组不生效 | 命令组在**下次进程启动**时注册（CLI 每命令独立进程，自然生效） |


## 事件监听（0.76+）

插件可以通过 Cordis 标准 `ctx.on` 监听跨域事件：

```typescript
// 监听全部事件
ctx.on("ygl", (evt) => {
  console.log(evt.kind, evt.entityId);  // e.g. "node.unlock" "sn123"
});

// 监听特定类型
ctx.on("ygl:node.unlock", (evt) => { /* ... */ });
ctx.on("ygl:kb.add", (evt) => { /* ... */ });
ctx.on("ygl:claim.resolve", (evt) => { /* ... */ });
```

事件在 logEvent 落表后即时发出（事件驱动 SSE 同通道）。支持的事件类型见 `packages/core/text/src/eventbus.ts`。
