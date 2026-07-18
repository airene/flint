# Task Run History 设计

## 目标

在任务页 Repository 状态条下方增加左侧 History 列表。每一项对应一次 Agent Run；点击后，右侧统一展示该 Run 的详情。页面首次加载默认选择最新 Run，解决 Developer、Reviewer 面板只能看到最后一次运行且旧轮次难以还原的问题。

## 布局

保留任务标题、原始需求、操作按钮和 Repository 状态条。其下改成两栏：左侧固定宽度约 220px 的 History，右侧为选中 Run 的详情。

History 按时间倒序显示，每项包含角色、CLI 名称、状态、时间和 Prompt 第一行。角色序号按时间正序计算，例如 `Developer #1`、`Reviewer #1`、`Developer #2`。失败、取消、运行中使用现有状态颜色。

## 选择行为

- 首次载入任务或切换任务时选择最新 Run。
- 用户点击旧 Run 后，普通事件刷新和状态更新不得抢走选择。
- 新 Run 被加入列表时自动选择该 Run。
- 没有 Run 时显示空状态，任务创建和启动操作保持可用。

## Run 详情

详情区展示选中 Run 的角色、provider、状态、时间、session、Prompt、最终回复或错误，并仅展示该 Run 的 Activity。

Reviewer Run 同时展示其 `structuredOutput` 中的 verdict、summary 和 findings。若选中 Run 正是当前仍可操作的 feedback review，则继续使用数据库中的 findings、人工批注、勾选和 FeedbackEditor；旧 Reviewer Run 只读展示其原始结构化结果。

原始任务标题和需求始终固定在页面顶部，不随 History 选择变化。

## 数据与兼容

复用现有 `runs`、`events`、`structuredOutput` 和当前 findings，不新增数据库字段或 API。旧 Reviewer Run 的历史人工批注、勾选和 dismiss 状态目前没有保留，本功能不扩展该数据模型。

## 测试

覆盖 History 倒序与角色序号、默认最新、手动选择稳定、新 Run 自动选中、选中 Run 的事件隔离、旧 Reviewer 结构化结果只读展示，以及完整开发—Review—反馈后的历史切换。

## 约束

- 不改变任务状态机、feedback 来源校验或 CLI 运行逻辑。
- 不提供 Run 删除或重跑。
- 不暂存、不提交代码或文档。
