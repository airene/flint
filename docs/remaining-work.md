# 剩余工作分级

## 当前需要做

- **接通页面内审批。** 审批表、接口和卡片已经存在，但 Codex/Claude Driver 仍声明不支持审批，生产路径不会产生可处理的审批请求。需要接入结构化双向协议，仅允许 Developer 的“允许一次”或“拒绝”，并处理服务中断后停在 `resolving` 的请求。
- **补齐 Review 失败后的人工兜底。** 结构化解析失败时目前只能查看原始回复，不能按规格复制、编辑并形成可发送反馈；Reviewer 失败或取消还会显示为“Review in progress”，重新 Review 失败后也会隐藏上一轮仍有效的反馈入口。需要统一失败文案，并保留上一轮可继续处理的 Review 上下文。
- **把投递幂等和重启语义做成持久化状态。** Feedback 的活动租约仍只在内存中，进程若在 Developer Run 完成后、标记发送前退出，重启后可能重复发送；普通排队消息则会在服务重启后自动恢复并消耗订阅，与规格要求的“用户确认后重试”不一致。两条链路都应以数据库状态和明确重试动作作为权威来源。
- **完成真实 CLI Smoke 验收。** 自动测试、E2E、类型检查和构建已经覆盖主流程，但真实 Codex/Claude smoke 仍未执行。应在临时仓库中验证精确 Session 恢复、结构化 Review 和只读边界；这一步会使用 CLI 订阅，执行前仍需用户明确确认。
- **修正 Finding 到 Diff 的跳转。** 当前点击 Finding 只加载对应文件，没有自动打开 Diff 抽屉并定位行号；需要把“打开 Diff、选择文件、定位范围”连成一次完整操作。

## P1（不是很着急）

- **验证并补充 Claude 图片能力。** Codex 的首轮和 resume 图片已经接通；Claude 非交互模式仍无已确认的等价图片协议，因此当前会明确禁用或阻止，而不会静默丢图。后续应分别验证 Claude 的首轮、resume 和 Reviewer 图片通道，通过真实契约测试后再启用。
- **给大仓库和长输出增加容量边界。** `/git/status` 仍会执行完整 capture，未跟踪文件与失败前的 stderr 可能整段进入内存。应拆分轻量状态查询与完整 Review snapshot，为单文件、输出预览和任务存储设置上限，并采用流式 hash 或截断策略。
- **为事件历史增加分页和虚拟滚动。** 前端虽只保留最近 5000 条事件，但首次进入 Task 仍从 sequence 0 全量重放，长任务会产生不必要的数据库读取、网络传输和渲染开销。应支持最近 N 条、加载更早记录和虚拟列表。
- **优化 SQLite 运行参数。** 当前只启用外键，没有设置 WAL、`synchronous` 和 `busy_timeout`；高频事件逐条写入时吞吐有限，短暂锁竞争也更容易直接失败。可在不引入旧库迁移链的前提下补充这些连接级参数和压力测试。
- **增加本地 API 会话令牌。** Loopback、Origin 和 JSON Content-Type 已覆盖浏览器攻击面，但任意本地进程仍可调用写接口并借用已登录的 CLI。启动时生成短期随机令牌并同时保护 HTTP 与 WebSocket，可提供额外纵深防护。
- **补强契约和工程质量门。** Review 行号需要校验 `endLine >= startLine` 以及文件与范围成组出现；工程侧可让 `typecheck` 直接覆盖 Vue 模板、统一 Zod 版本并增加 lint/format。数据库继续采用“新库完整建表 + 显式全量重建”，不维护增量迁移链。
- **补充清理与可观测性。** 增加过期附件草稿清理、任务存储统计，以及 feedback/message 的 reserved、running、sent、failed、retryable 展示，方便判断是否需要安全重试。
- **完善 Review 与 Diff 日常操作。** 可加入人工 Finding、文件搜索与变更类型过滤、Finding 上一个/下一个、Token 用量汇总，提升日常使用效率，但不改变人工反馈门。

## P2（长期规划）

- **Task 级 Worktree 隔离与并行。** 为每个 Task 创建独立工作目录，隔离既有脏改动，并在安全约束下允许同一仓库的多个 Task 并行；同一个 Task 内仍保持 Developer/Reviewer 单 Run 串行。
- **Review 对比、Finding 生命周期与 Checkpoint。** 对多轮 Review 标记 new、persisted、resolved、regressed，并在 Developer Run 前后保存可比较的 snapshot metadata；只提供比较和人工确认，不自动 reset 用户仓库。
- **多 Reviewer 顺序与并行评审。** 支持同一轮变更交给多个 Reviewer 顺序或并行评审，并按文件、行号范围和内容指纹对多方 findings 去重合并；反馈仍经人工选择后发送。
- **任务模板、Review Profile 与运行预算。** 支持复用验收模板和评审规则，并把 model、reasoning、时间、轮次或用量预算固化到 Task/Run，保证历史可重现且不受全局设置漂移影响。
- **桌面壳与原生目录选择。** 本地 Web 版稳定后可增加桌面包装、单实例、原生仓库选择和日志定位；仍遵守“浏览器或应用关闭后不发送任务完成通知”的当前产品约束。
- **导出与外部开发链路。** 支持导出 patch、Diff、Task 时间线和审计报告，再按需要扩展 IDE 跳转、GitHub/GitLab PR 与 Review comment 同步；Commit、Push 和发布动作必须继续由用户明确触发。
- **Provider 扩展能力。** 在现有 Driver/Registry 基础上评估 Gemini、OpenCode 或 ACP，并把 Provider 契约进一步注册表化；新增 Provider 前必须先证明权限、图片、Session 和审批能力边界。
- **最小 CI。** 当前提交前仍以人工 review 代码为主，机器门禁不迫切；等协作人数或提交频率上升后，再补一条跑 `typecheck`、`bun test` 和 `build` 的最小流水线。

## 明确不做

- **可选的自动触发 Review。** 开发完成后自动启动 Reviewer 贴近“不做自动 Review 循环”的非目标；所有 Review 一律由用户显式触发，此项明确不做。
