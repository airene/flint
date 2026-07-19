# CLI 连续互动与人工审核设计

## 状态

产品方向已由项目负责人于 2026-07-19 确认。Provider 的图片和双向控制能力仍须在实现时通过真实 CLI 契约测试；本文不包含代码修改。

## 结论

1. **Review 完成后可以继续和该 Reviewer 对话。** Flint 应恢复所选 Review Run 的精确 CLI session，而不是启动无上下文的新 Reviewer。追问仍使用 Reviewer 的只读权限，并作为新的 `reviewer_followup` Run 留在 History 中；它不会生成新的正式 findings，也不会替代“再次 Review”。
2. **Task 初始需求和后续消息都可以从剪贴板粘贴图片并带给 CLI，但需要统一附件通道。** 当前 `FileMentionInput` 只有文本和仓库文件 mention，没有图片处理。2026-07-19 本机验证的 Codex CLI 支持在新会话和 resume 时使用 `--image`；Claude 的交互式会话支持粘贴图片，但 Flint 使用的非交互模式没有与 Codex 等价的已确认图片参数，必须由 adapter 分别验证首轮和 follow-up 能力。UI 只有在当前 provider 对本次投递声明支持图片时才允许发送，不能静默丢弃截图。
3. **执行中可以继续发消息，但同一个 Task 永远只能有一个活动 Run。** 当前 Flint 写入首段 prompt 后立即关闭 stdin。同角色消息默认在当前 turn 结束后恢复目标 session；用户也可选择“中断并发送”。如果 Reviewer 正在运行而用户向 Developer 发修改要求，Flint 必须立即中断 Reviewer，再恢复精确 Developer session，因为继续 Review 即将失效的代码没有价值。Developer 运行时发给 Reviewer 的消息等待 Developer 结束后再发送，不并发运行两个角色。
4. **审核请求可以带到页面并把决定发回 CLI，但必须换成双向控制协议。** 当前错误文本只能提示“需要权限”，无法承载结构化请求或回复。MVP 只支持 Developer 的单次允许和拒绝；Reviewer 永远只读，不出现写操作审核。provider 不支持双向审核时应明确显示“不支持页面内审核”，不能把失败误报为待审核。

## 目标

- 任务页始终有一个面向当前 CLI 上下文的消息输入框。
- 可对 Developer 追加指令，也可对任意已完成的正式 Review 发起只读追问。
- 创建 Task 的初始需求和后续消息都可带从剪贴板粘贴的图片，并在发送前预览或移除。
- Run 执行中仍可提交新消息，且用户能看懂它何时会送达。
- CLI 发起权限请求时，页面展示足够的信息，让用户做一次性允许或拒绝。
- 所有消息、附件引用、审核请求和决定在刷新后仍可追溯。
- 同一 Task 的 Developer 和 Reviewer 永不并发运行。

## 非目标

- 不做多人聊天、远程访问或跨机器同步。
- 不在 Reviewer 追问中开放 Bash、Edit、Write 或仓库修改能力。
- 不提供“永久允许此命令”或全局权限白名单。
- 不保证浏览器消息能打断 CLI 当前正在执行的单个工具调用。
- 不把普通 Reviewer 追问解析为正式 findings；需要新 findings 时仍使用“Start review”。
- 不支持同一 Task 内的多 Agent Run 并发。

## 方案选择

采用“**持久化控制面 + provider 能力适配**”。

- 只用现有一次性 resume 最简单，但无法承载执行中消息状态和审核回复。
- 全面改成 provider 专属的长期交互进程能力最强，但会把产品行为绑定到实验性协议，失败恢复也更复杂。
- 推荐方案让 Flint 自己保存消息和审核状态，再由 adapter 声明 `liveMessages`、`images`、`approvals` 能力。基础队列和精确 session resume 对所有 provider 一致；实时发送和页面内审核按能力启用，并保留清晰降级。

## 交互模型

### 1. 初始 Task 输入

Project 页的 Task 创建输入框与任务页消息输入框复用同一套图片 paste、预览、删除和限制规则。图片先上传为 project-scoped attachment draft；Task 尚未创建时不要求 task ID。

`CreateTaskRequest` 同时提交文本和 attachment IDs。Server 在 dirty-working-tree 检查通过、Task 成功创建的同一流程中认领这些附件，然后才启动 `developer_initial`。如果创建因 dirty working tree 等可重试冲突失败，draft 保留并在用户确认后复用；跨 Project、已被认领或已过期的 attachment ID 必须拒绝。

Developer provider 必须把初始文本和图片作为同一首轮输入接收。后续正式 Review 也应把这些初始图片作为原始需求证据交给 Reviewer；如果 Reviewer adapter 未通过图片能力验证，Flint 阻止启动该 Review 并明确说明原因，不能执行一个看不到完整需求的 Review。

### 2. 后续输入目标

输入框上方显示目标：

- `Developer · <provider> · <session>`：追加开发或修改指令。
- `Reviewer · Review #N · <provider> · <session>`：追问选中的正式 Review。

选择历史 Review 时只改变追问目标，不改变当前 findings 编辑器的数据来源。Reviewer 追问继续使用该 Review Run 的 `externalSessionId`、工作目录和只读启动参数。

Reviewer follow-up 是工作流状态中立的：开始和结束追问都不把 Task 切换到 `reviewing`，Task 仍保留原来的 `waiting_for_human`、`ready_for_review` 或其他状态。Developer follow-up 可能修改仓库，因此继续沿用现有 `fixing → ready_for_review` 流程。

### 3. 执行中的消息

发送时若没有活动 Run，Flint 立即恢复目标 session 并创建 follow-up Run。

发送时若已有活动 Run，按目标角色处理：

- **活动 Run 与消息目标相同**：默认进入 FIFO 队列，在当前顶层 turn 完成后恢复目标 session；用户可主动选择“中断并发送”。多条排队消息合并为一个有顺序标记的下一 turn，减少重复启动 CLI。
- **Reviewer 活动、消息目标为 Developer**：不提供继续等待选项，立即请求中断 Reviewer。只有 Reviewer Run 进入 `cancelled` 或 `interrupted` 后，才恢复精确 Developer session 并进入 `fixing`。被中断 Review 不产生可发送的 findings。
- **Developer 活动、消息目标为 Reviewer**：消息排队到 Developer Run 终态后再发送。不得让 Reviewer 对仍在变化的工作区启动，也不得与 Developer 并发。

provider 的实时通道通过能力探测后，可以把发给同一活动角色的消息直接送达当前 turn，但不能绕过上述跨角色规则。状态必须从 `queued` 变成 `delivering` 再变成 `delivered`，不能仅因浏览器请求成功就显示已送达。

### 4. 剪贴板图片

- 图片属于一次用户输入，而不是属于 resume：它可以绑定到 Task 初始需求，也可以绑定到任意 Developer/Reviewer follow-up 消息。
- 输入框处理 `paste` 事件中的 `image/*`，文本粘贴保持原行为。
- 每条消息最多 4 张图片，每张不超过 10 MiB；接受 PNG、JPEG、WebP 和非动画 GIF。
- 页面显示缩略图、文件类型、大小和删除按钮。上传完成前不能发送。
- Server 根据文件签名字节校验类型和大小，不信任浏览器提交的 MIME。
- Task 创建前的原图保存在 Flint 数据目录的 project-scoped draft 目录；创建或发送成功时转为 task-scoped attachment。任何阶段都不写入 Git 仓库，也不出现在仓库 diff 中。
- 消息只保存附件 ID；provider adapter 在发送时解析为受控绝对路径或原生图片参数。
- provider 不支持图片时，输入框仍可发送文本，但图片发送按钮禁用并说明原因。

### 5. 审核请求

Developer CLI 的结构化权限请求保存为 `ApprovalRequest`，包含 task、run、provider request ID、工具名、脱敏后的命令或动作摘要、工作目录、创建时间和状态。

页面在当前 Activity 中显示审核卡片：

- `允许一次`：只批准该 provider request ID。
- `拒绝`：把拒绝决定和可选理由发回该 request ID。

决定必须幂等；重复点击返回同一个结果。Run 终止时仍未处理的请求自动变为 `expired`。Reviewer Run 不接受 approval；如果只读边界产生写权限请求，Flint 拒绝请求并把它记录为安全错误。

## 数据与接口

新增三个持久化实体：

- `TaskMessage`：目标角色、源 Review Run（可空）、文本、投递模式、状态和时间。
- `TaskAttachment`：Project、Task 初始需求或后续 message 的所属关系、draft/claimed 状态、受控存储路径、媒体类型、大小和校验摘要。
- `ApprovalRequest`：Run/provider 请求映射、脱敏展示内容、状态、决定和时间。

建议接口：

- `POST /api/projects/:projectId/attachment-drafts`
- `POST /api/projects/:projectId/tasks` 的 request 增加 `attachmentIds`
- `POST /api/tasks/:taskId/messages` 的 request 增加 `attachmentIds`
- `GET /api/tasks/:taskId/messages`
- `POST /api/approvals/:approvalId/decision`

WebSocket 增加 `message_queued`、`message_delivered`、`message_failed`、`approval_requested` 和 `approval_resolved` 事件。数据库状态是权威来源，WebSocket 只负责及时刷新。

## 错误与恢复

- 缺少精确 session ID：消息保持失败状态，不允许回退到“最近 session”。
- 图片上传成功但 Task/消息未发送：draft 保留，可重试；24 小时未被 Task 或消息认领的 draft 可清理。
- provider 不支持实时消息：自动排队，不显示错误。
- provider 不支持审核回复：Run 按现有失败路径结束，并显示能力说明。
- Server 重启：活动 Run 按现有恢复逻辑标记 interrupted；queued 消息保留，用户确认后重试，不静默消耗订阅额度。
- stale Review：追问仍可只读进行；任何 Developer 修改消息继续遵守现有工作区和任务锁。
- 中断 Reviewer 后：清除该 Run 尚未完成的结构化 Review 结果，保留事件和错误记录；Developer follow-up 只能在 Reviewer 到达终态后开始。

## Worktree 交付边界

本文是 CLI 连续互动能力的产品真相源，不按代码目录拆成多份 spec。实现按依赖和文件所有权拆到以下 plan：

- [Interaction Foundation](../plans/2026-07-19-interaction-foundation.md)：共享契约、持久化 schema 和数据库端口，必须串行先完成。
- [Provider Control](../plans/2026-07-19-provider-control.md)：Codex/Claude 能力探测、图片传递、中断和审批控制适配。
- [Attachments](../plans/2026-07-19-attachments.md)：附件 draft/claim 服务与可复用输入组件。
- [Conversation Orchestration](../plans/2026-07-19-conversation-orchestration.md)：精确 session follow-up、单活动 Run 和跨角色调度。
- [Approval Relay](../plans/2026-07-19-approval-relay.md)：结构化审核请求、一次允许或拒绝及审核卡片。
- [Interactive Features Integration](../plans/2026-07-19-interactive-features-integration.md)：统一接入共享 API、store、页面和综合测试。

总执行顺序和 worktree 规则见 [CLI Continuous Interaction Orchestration Plan](../plans/2026-07-19-cli-continuous-interaction.md)。子计划不能自行修改 integration 计划列出的共享热点；需要新增接线时，通过模块导出和专属测试证明接口，再由 integration 工作树统一接入。

## 验收标准

1. 用户可从一个已完成 Review 发送追问，Run History 出现只读 `reviewer_followup`，并使用该 Review 的精确 session。
2. Developer 空闲时发送新指令会恢复精确 Developer session。
3. Developer 运行中发送的消息显示排队状态，并在当前 Run 完成后自动投递；中断模式先产生终态再投递。
4. 创建 Task 时粘贴合法图片，Developer 首轮收到文本和图片；dirty working tree 确认重试不会丢失或重复认领附件。
5. 后续消息粘贴合法图片后可预览、删除、刷新后恢复，并由支持图片的 provider 收到；所有图片都不污染仓库状态。
6. 正式 Review 能收到 Task 的初始图片；Reviewer provider 不支持时明确阻止启动，而不是忽略附件。
7. 页面能展示结构化审核请求，一次性允许或拒绝后 CLI 收到对应决定；重复决定不会执行两次。
8. Reviewer 不会因追问或审核功能获得写权限。
9. Reviewer 运行中向 Developer 发送修改要求会立即中断 Reviewer；同一 Task 的 Developer 与 Reviewer 在任何时刻都不会同时运行。
