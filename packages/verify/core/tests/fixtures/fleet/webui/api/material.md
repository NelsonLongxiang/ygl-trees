# WebUI 数据接口验收（api）

验收对象：被验提交构建出的 `ygl-trees webui serve`，加载种子工作区库的副本。
数据源：probe.mjs 起服务后逐个请求前端依赖的接口（首页、api/data、api/verify/specs、api/verify/reports、api/verify/materials、api/verify/archives，以及用 api/data 里第一个节点拼出的 api/node），写入只读 SQLite 快照表 endpoints(path, kind, status, ctype, bytes, json_ok, items)，kind 为 page 或 api。

## 判据

A1 前端依赖的每个接口必须正常返回：endpoints 中 status 不为 200 的行必须为 0。
A2 数据接口必须返回可解析的 JSON：endpoints 中 kind 为 api 且 json_ok 为 0 的行必须为 0。
A3 主数据接口必须带内容：endpoints 中 path 为 /api/data 且 items 小于 1 的行必须为 0。
A4 接口面不得缩水：endpoints 的行数不得少于 7。

## 纪律

- 服务只读种子库副本，不碰用户工作区。
