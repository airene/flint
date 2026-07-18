# CLI 角色配置设计

## 目标

Settings 提供 Developer CLI 与 Reviewer CLI 两个全局下拉框。选项来自服务端 provider registry，而不是前端硬编码。配置仅作为新任务默认值；任务创建时固化角色 provider，已有任务继续使用原 provider 与 session。

## Provider registry

服务端为每个已接入 CLI 注册 `id`、展示名称、支持角色与 driver。当前 Codex、Claude 都支持 `developer` 和 `reviewer`。Settings API 返回 registry 描述、实时 availability、Git 状态以及当前全局角色默认值。不可用或未登录的 provider 保留显示但禁用；已保存的不可用选择不被自动清除。

未来增加 CLI 时需要新增 provider 类型、driver 与 registry entry，但 Settings 下拉框、角色标签和运行面板不需要再添加 provider 专用分支。

## 持久化与兼容

`app_settings` 新增 `agent.defaultDeveloper`、`agent.defaultReviewer`。默认值保持 Codex / Claude。

`tasks` 新增 `developer_provider`、`reviewer_provider`，默认值分别为 `codex`、`claude`。启动时以幂等 `ALTER TABLE` 兼容旧数据库，并自动为旧任务回填原组合。新任务从当时的全局设置复制 provider；之后修改 Settings 不影响该任务。

## 角色化运行

`AgentStartRequest` 携带 `runType`。`AgentRunService` 根据任务中固化的角色 provider 选择 driver；session 按 run type 写入 developer/reviewer 字段，不再按 provider 判断。

- Codex Developer：保持 `workspace-write`，feedback 使用原 Codex session resume。
- Codex Reviewer：使用 `read-only` 与 review output schema；从最终 agent message 解析结构化结果。
- Claude Reviewer：保持 `plan`、只读 tools 与 review JSON schema。
- Claude Developer：使用 `acceptEdits`、用户自己的 Claude permissions 和 exact-session resume；不使用 `bypassPermissions`。

API 在每次运行前检查任务固化 provider 的 availability。provider 临时不可用时返回现有 `CLI_UNAVAILABLE`，任务配置不改变。

## UI

Settings 在 CLI cards 上方显示两个下拉框。选项由 registry response 生成，显示 provider 名称和 unavailable/login-required 状态；保存与 executable path 共用 `Save & recheck`。

Task 页面按 run type 分成 Developer 与 Reviewer 面板，标题、availability 门禁和 session 标签使用任务固化 provider，不再固定显示 Codex Developer / Claude Reviewer。

## 测试

覆盖角色设置持久化、旧数据库迁移、新任务快照、设置变更不影响旧任务、四种 Codex/Claude 组合、角色化 CLI 参数、结构化 Codex review、按角色保存和恢复 session、动态 Settings UI 与完整 feedback E2E。

## 约束

- 不提供 task 级手动切换。
- 不提供模型切换。
- 不启用 Claude `bypassPermissions`。
- 不暂存、不提交代码或文档。
