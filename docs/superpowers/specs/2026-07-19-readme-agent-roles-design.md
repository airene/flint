# README Agent 角色说明更新设计

## 目标

让 README 准确反映 Flint 当前的角色化运行方式：Developer CLI 与 Reviewer CLI 均可在 Settings 配置，默认组合为 Codex Developer / Claude Reviewer。Reviewer 始终以只读权限运行，人工确认后的 feedback 恢复任务固化的 Developer 精确 session。

## 修改范围

- 项目简介以 Developer / Reviewer 描述核心工作流，并注明默认 provider 组合。
- 配置章节说明两个角色下拉框、当前支持的 Codex 与 Claude、设置仅作为新任务默认值，以及已有任务保留原 provider 和 session。
- 安全章节按角色描述权限边界，并保留 Codex 与 Claude 的原生权限实现差异。
- 工作流程使用 Developer / Reviewer，不再把开发、评审和 session 恢复写死为某个 provider。
- MVP 限制使用 Developer / Reviewer 表述自动循环。
- 真实 CLI smoke-test 章节继续使用 Codex 与 Claude 的具体名称，因为它描述的是现有测试命令。

## 约束

- 不修改产品行为、代码或测试。
- 保留工作区中已有的 `bun run dev` README 修改。
- 不修改 `package.json` 的现有未提交内容。
- README 保持面向初次接触项目的读者，不展开完整 provider 参数矩阵。

## 验证

- 搜索 README 中所有固定的 `Codex 开发`、`Claude review`、`Codex session` 和 `Codex/Claude 循环` 表述。
- 检查默认组合、设置作用范围、Reviewer 只读约束和 Developer 精确 session 恢复均有清晰说明。
- 检查 diff，确保原有未提交修改被保留且没有改动 README 之外的用户文件。
