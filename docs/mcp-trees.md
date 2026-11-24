# MCP trees 过渡契约

服务名为 `ygl` 时工具全名是 `mcp__ygl__trees`。MCP 服务端登记短名 `trees`；stdio 与 HTTP 共用同一处理器。

本版首选单一渐进式披露入口，原 `read/write/verify/doctor` 保留一个发布版本过渡。本版 tools/list 是 trees 加旧四工具；旧调用参数、返回 JSON、rc 与 isError 保持原样。旧工具 _meta 声明 replacement=trees、retain_releases=1。下一版移除旧工具须另行发布，不在本次执行中移除。

## 从目录到动作

调用树分三层，help 不启动 CLI、不读写工作区：

~~~json
{"action":"help"}
{"domain":"kb","action":"help"}
{"domain":"kb","action":"help","params":{"action":"add"}}
~~~

第一层返回领域目录；第二层返回该领域动作和读写分类；第三层返回参数 JSON Schema（参数描述标明适用动作）。执行时只用顶层 domain/action 选路由，其余参数放 params：

~~~json
{"domain":"kb","action":"search","params":{"query":"上次结论","scope":"bench:team","eval":false}}
{"domain":"kb","action":"add","params":{"name":"结论","body":"证据与限制"}}
{"domain":"verify","action":"run","params":{"a":"spec_id","b":"snapshot.sqlite"}}
{"domain":"doctor","action":"check"}
{"domain":"doctor","action":"fix"}
~~~

read/write 原 domain/action 不变；verify 增加 domain=verify，参数 a/b/c/db 等移入 params；doctor fix=false 或省略映射为 doctor/check，fix=true 映射为 doctor/fix。doctor/check 不接受 params.fix，不能借参数升级修复权限。

未知领域/动作、原型属性名、顶层额外键、params 中的 domain/action 与非法参数类型/枚举均 rc2，交给现有 MCP 错误信封输出 isError:true。原 CLI 冻结 JSON 不包新业务信封。管理面（db reset/sql、project sync、plugin/config/job/patrol 等）仍不在闭集内。

## 宿主方案 A 消费的访问元数据

契约标识为 `ygl-trees/1`。tools/list 中 trees._meta["ygl-trees/dispatch"] 提供：

- domain_key=domain、action_key=action、params_key=params。
- routes 为精确 {domain,action,access,legacy_tool} 闭集。access 为副作用分类 read 或 write；legacy_tool 为原工具归属 read、write、verify 或 doctor，两者不可混用。
- help_access=read；unknown=deny。

同一张路由目录用于 help 和真正分派，执行前不采用调用者自报的 access 或 legacy_tool。宿主按真实角色和顶层 domain/action，在发起 MCP 调用前应用其授权策略；缺少契约、未知动作或无法识别的参数形状应拒绝，不能猜成 read。过渡期仍须约束旧工具，不可因 trees 被拦就回退旧 write/verify/doctor。该元数据是授权输入，不是服务端角色认证；此步骤不在 ygl-trees 内实现 DSH 角色授权。

第二步提出的兼容口径：宿主校验 contract=ygl-trees/1 和 routes 后动态判权，总工/观察者沿用 legacy_tool=read 的原读面，其余及未知路由拒绝，不在宿主硬编码动作表。该策略保留现有检索能力，也保留原读面的计数、评估和索引副作用；它不是严格禁止所有写入的策略。若宿主选择严格无业务写入策略，应同时要求 access=read。最终角色政策由宿主实施与审核，不由本元数据自动授予。

整个 trees 混合读写，标准 MCP annotations.readOnlyHint=false、destructiveHint=true、openWorldHint=true；标准 annotations 不是逐动作授权。**不能仅按工具名 trees 将全部调用当只读。**

分类按可能副作用保守判断，避免沿用旧工具名称的误导：

| 动作 | access | 原因 |
|---|---|---|
| agent/match、skill/match | write | 匹配会增加 hits |
| kb/search | write | 搜索会增加 reuse，可选 eval 也可能调用模型 |
| research/claim-evaluate | write | 模型评估可能写审计事件 |
| node/validate | write | 刷新派生索引 |
| verify/submit、prepare、run、tree-prepare、tree-run | write | 冻结、产出或执行验证 |
| verify/meta、lint-candidates | write | 保守限制验证与文件处理能力 |
| verify/report、trace、archive、example、tree-report、tree-trace | read | archive 在旧 MCP 中仅映射 archive verify（不创建归档） |
| doctor/check | read | 诊断，无 fix |
| doctor/fix 与全部旧 write 路由 | write | 修改工作区 |

其余旧 read 路由标 read。access=read 表示不请求业务变更；CLI 正常打开、锁和派生运行态遵循既有生命周期，并非 OS 只读沙箱。legacy_tool=read 仅说明原来从 read 工具进入：例如 kb/search 是 legacy_tool=read、access=write。当前路由向原执行器的归属在版本内稳定，不能为迁就宿主策略把副作用改标为 read。

## 版本与验证

新增输入不传入未经白名单的 CLI 参数；复用原闭集的执行器、project/scope 透传、HTTP 请求会话隔离、网络 fetch 默认拒绝和 export 路径限制。完整兼容与失败场景由包级 MCP 测试、stdio/HTTP 集成及仓库 pnpm test 验证；完整发布检查使用 pnpm pack:check。
