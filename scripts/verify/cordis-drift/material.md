# Cordis 应用情况评审 · 漂移守卫（cordis-drift）

本材料把 m00310 的一次性 Cordis 应用评审（tmp/review-cordis.md）固化成可每轮重跑的不变量。
评审对象：本仓库 packages/**、apps/** 的 src 代码（不含 vendor/、node_modules/、dist/、tests/）。
数据源：scripts/cordis-scan.mjs 扫描生成的只读 SQLite 快照（四张表 cross_domain_imports / event_sites / service_defs / bare_event_inserts，附 source_digest）。

## 不变量

I1 域间直连只允许白名单内的历史债务：allowed=0 的 cross_domain_imports 行必须为 0。
I2 事件面不得萎缩：event_sites 的调用点总数不得少于 20（ctx.on / ctx.emit / onEvent / onEventKind / emitEvent）。
I3 0.86 已删除的服务不得复活：service_defs 中 class 为 TechTreeService 或 WebAppService 的行必须为 0。
I4 每个 Cordis 服务必须在同一文件声明 ctx 合并：has_declare_module=0 或 ctx_key 为 NULL 的行必须为 0。
I5 事件表裸写只允许既有存量：bare_event_inserts 的写入点数不得超过 13（冻结基线，收敛另行排期）。

## 纪律

- 快照只用副本：扫描写 tmp/，verify run 只读副本；报告记 as_of 与 sha256。
- 白名单只减不增：新增跨域直连一律视为漂移；确需新增时先改这份材料再升 spec 版本。
- 本材料是 spec 的唯一事实源：判据必须逐字引用上面五行，不得改写。
