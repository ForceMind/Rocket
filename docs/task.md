# 后台 UI 重构任务清单

- [x] 1. 结构与导航重建
  - [x] 修改 `admin.html` 中的顶层 tab，从“数据总览”、“当前对局”重组为“游戏状态”、“数据看板”。
  - [x] 更新 `admin.js` 中切换 tab 的逻辑（如有写死的 ID 需要替换）。

- [x] 2. 改造“游戏状态 (Game Status)” 面板
  - [x] 移出原本 `tab-overview` 中冗长的数据统计子页签。
  - [x] 在顶部保留并加强 `metric-banner`，增加 7 天 RTP、当前系统净利润等指标。
  - [x] 把原来 `tab-live` 的“当前对局”监控（回合 ID、当前倍率、真实爆点、硬控原因等）搬移整合到此页签，新增展示本局真人下注额与机器人下注额。
  - [x] 在 `admin.js` 的 `renderRound()` 及 `renderMetrics()` 中，绑定新增的 DOM 节点并填入数据。

- [x] 3. 改造“数据看板 (Analytics)” 面板
  - [x] 设立独立的 `tab-analytics` 页签。
  - [x] 将原先的 `subtab-daily`, `subtab-user`, `subtab-rounds` 及数据筛选器迁移至此。
  - [x] 调整这些面板的布局，使其分类更加清晰。

- [x] 4. 样式调整与测试
  - [x] 确保功能正常运作。
