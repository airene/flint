# 未完成任务与浏览器通知设计

## 状态

产品范围已由项目负责人于 2026-07-19 确认：全局未完成 Task 只做实时状态，浏览器通知只覆盖当前 Task，浏览器关闭后不通知。本文不包含代码修改。

## 结论

1. **左侧仓库列表下展示所有未完成 Task，并在每项前显示实时状态。** 当前工作树已有列表雏形；MVP 增加全局 unfinished 摘要接口和轻量状态流，避免前端逐 Task 查询 runs。未完成仍固定为 `status !== "completed"`。
2. **进入未完成列表的时机是 Task 创建成功，退出时机只有显式完成。** `draft`、`developing`、`ready_for_review`、`reviewing`、`waiting_for_human` 和 `fixing` 都属于未完成。Run 失败、取消或中断不会让 Task 消失；它仍需要用户处理。
3. **只为当前打开的 Task 发浏览器通知。** “一个步骤完成”定义为一次完整的 Developer Run 或 Reviewer Run 产生 `run_completed`，不是内部 turn、tool 或 command。页面不可见时通知；浏览器关闭后不通知，也不做全局后台 Task 通知。

## 目标

- 用户从任何页面都能看到所有仓库中需要继续处理的 Task。
- 每个未完成 Task 前有实时状态，能区分正在运行、等待人工、可 Review、失败/中断后待处理等情况。
- 当前打开 Task 的每次 Developer/Reviewer Run 成功完成时，在页面不可见的情况下发浏览器通知。
- 点击通知直接打开对应 Task。

## 未完成与注意力规则

未完成的唯一持久化判定是 `task.status !== "completed"`。展示状态由 Task 和最新 Run 派生：

- active Run 为 `queued/running`：`执行中`；
- 存在 pending approval：`待审核`；
- 最新 Run 为 `failed/cancelled/interrupted`：`需处理`；
- Task 为 `waiting_for_human`：`待人工确认`；
- Task 为 `ready_for_review`：`可发起 Review`；
- Task 为 `draft`：`待开始`；
- 其余使用 Task 状态标签。

优先级为 `待审核 > 需处理 > 执行中 > 待人工确认 > 可发起 Review > 其他`。列表先按注意力优先级，再按 `updatedAt` 倒序。每项显示实时状态点、仓库名、Task 标题和状态文案；当前 Task 高亮。

完成 Task 后立即从列表移除。以后如增加 reopen 功能，重新打开的 Task 立即回到列表；本期不新增 reopen。

## 通知规则

通知设置放在 CLI Settings 或单独的本地设置区，由用户点击“启用浏览器通知”后才调用权限 API。拒绝权限不会影响 Task 功能，也不反复弹窗。

通知只绑定当前 Task 的事件流。唯一触发事件是一个 Developer 或 Reviewer Run 产生 `run_completed`。

`run_failed`、`run_cancelled`、`run_interrupted`、`approval_requested`、`turn_completed`、`tool`、`command`、流式文本和普通 Activity 更新都不通知。失败、中断和待审核仍会更新左侧实时状态。一次 Run 无论内部包含多少 turn 或工具调用，成功结束时只通知一次。

以下情况不通知：

- 当前标签页可见；
- 事件不属于当前打开的 Task；
- 同一个 persisted event 已经通知过；
- 用户关闭通知或浏览器权限不是 `granted`。

通知标题包含当前 Task 标题，正文包含角色和“步骤完成”。点击后聚焦现有 Flint 标签页并回到当前 Task。

## 数据与刷新

Server 提供 `GET /api/tasks/unfinished`，一次返回 `UnfinishedTaskSummary[]`：Task 基本信息、仓库名、最新 Run 状态、pending approval 和派生 attention。页面首次加载使用该快照，随后订阅 app-level unfinished 状态流；Task 创建或状态、Run、approval 改变时 upsert，Task 完成时 remove。该流不包含 prompt、消息正文或完整 Activity。

通知仍复用当前 Task 已有的持久化事件流，不订阅其他 Task 的 Activity。去重使用当前 Task 的 event sequence；页面刷新不重复通知已处理 Run。本地设置保存启用状态和当前 Task 的已通知游标，不上传任何数据。

## Worktree 交付边界

本文是未完成 Task 与浏览器通知的产品真相源。实现按可独立验证的模块拆分：

- [Interaction Foundation](../plans/2026-07-19-interaction-foundation.md)：提供 unfinished summary 和 approval 等共享契约。
- [Task Attention](../plans/2026-07-19-task-attention.md)：未完成 Task 快照、状态派生、排序和轻量实时流模块。
- [Browser Notifications](../plans/2026-07-19-browser-notifications.md)：仅当前 Task 的通知判定、权限设置和事件去重。
- [Interactive Features Integration](../plans/2026-07-19-interactive-features-integration.md)：接入全局导航、当前 Task 事件流、设置页和综合测试。

总执行顺序和 worktree 规则见 [Task Attention and Notifications Orchestration Plan](../plans/2026-07-19-task-attention-notifications.md)。两个功能分支可以并行，但不得直接修改共享页面、全局 store、API 入口或综合测试；这些改动由 integration 工作树统一完成。

## 验收标准

1. 所有非 completed Task 都出现在左侧，跨仓库聚合；每项实时状态和排序符合规则，且不需要逐 Task 获取 runs。
2. 新建 Task 立即出现；失败/取消/中断后仍存在；标记完成后立即移除。
3. 浏览器权限只在用户主动启用时请求，拒绝后应用仍正常。
4. 当前 Task 每个 Developer/Reviewer `run_completed` 通知一次；内部 turn/tool/command 不通知。
5. 当前 Task 的失败、中断、approval request 和其他 Task 事件都不通知，但仍按规则更新页面状态。
6. 点击通知能回到当前 Task；刷新页面不会重复发送旧通知，浏览器关闭后不产生通知。
