# Flint 整体 Code Review

> 审查日期：2026-07-19
> 审查基线：`251b3eb chore project refactor`
> 范围：架构、服务端、Web UI、共享契约、Git/Agent 运行时、安全边界、持久化、测试与交付链路。
> 约束：本次只修改本文件，未修改任何代码、配置或测试。
> 更新（2026-07-19）：P0-1（Reviewer 严格只读）、P0-2（application/Run owner lease 与恢复 fencing）、P1-1（Create & start 语义与 E2E）、P1-2（smoke 传参）、P1-3（TS 工具链）、P1-4（逐 Review feedback draft）、P1-5（历史与实时 Git 解耦）、P1-6（base-relative Git 文件清单）、P1-7（Agent/Review 持久化脱敏）、`@file` 提及以及 P2-2 中前端去重/排序/内存上限部分已完成，相关内容已从本文移除；其余编号保持原状，故存在空缺。

## 1. 结论先行

Flint 不像一个只写了一天的普通原型：产品边界清楚，共享契约、状态机、事件持久化、WebSocket replay、精确 session 恢复、Git snapshot、Fake CLI 和完整的人工 feedback gate 都已经成型。当前 168 项 Bun 测试全部通过，核心域模型的基础质量是好的。

P0 安全阻断项和 P1 正确性项已经清零。当前剩余问题集中在幂等、容量治理和 schema 演进，适合按风险继续收敛。

我的总体建议是：**在扩大 provider 或交付链路前先完成持久化幂等与容量边界**。这会让后续的 worktree、桌面端、GitHub 集成和更多 Agent 建立在更稳固的数据边界上。

## 2. 做得好的地方

- **产品边界成熟**：人工选择、编辑、确认 feedback，不做自动 Agent 循环，是很好的默认安全立场。
- **核心并发约束有双保险**：Service 中的事务检查与 SQLite partial unique index 共同保护 task/project 活动 Run，比只靠前端禁用按钮可靠得多。
- **事件模型正确**：CLI 事件先入库、再广播；task-scoped sequence、重放与实时事件交接、前端 cursor 都有针对性测试。
- **Agent 运行时基础扎实**：命令参数数组、显式 `cwd`、精确 session ID 持久化、未知 JSONL 保留、子进程树取消与凭据环境过滤都有实现和测试。
- **Git 边界处理明显超过普通原型**：NUL 分隔、rename/copy、binary、untracked、symlink、SHA-256 repository、稳定 snapshot framing 和有限并发均有考虑。
- **测试分层合理**：状态机、Git、Driver/Parser、Review/Feedback、API、WebSocket、前端纯逻辑和 Playwright 分层清楚，Fake CLI 也避免了常规测试消耗订阅额度。
- **共享 Zod 契约是对的方向**：前端 API client 不仅有 TypeScript 类型，还校验运行时 response，能尽早暴露前后端漂移。

## 3. 验证记录

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `git status --short` | 审查前为空 | 工作区开始时干净 |
| `bun test` | **168 pass / 0 fail** | P1-5 与 `@file` 集成后，全部 24 个测试文件通过 |
| 不需要端口的 focused tests | **122 pass / 0 fail** | core、Git、Agent、Review、Web 纯逻辑全绿 |
| server/web/shared 源码单独 `tsc --noEmit` | 通过 | 不包含 shared test 与 Vue template 的局部类型检查 |
| `bun run typecheck` | 通过（2026-07-19 修复后） | shared 补 bun types；TypeScript 锁定 5.9.3；`scripts/**` 已纳入检查 |
| `bun run build` | 通过（2026-07-19 修复后） | shared 显式 `rootDir`；TS 回退 5.9.3 后 `vue-tsc` 恢复兼容 |
| server bundle | 通过 | Bun 成功 bundle 225 modules |
| `bun run test:e2e` | 通过 9 pass / 0 fail（2026-07-19 修复后） | 覆盖 Create & start 与逐 Review draft 隔离/恢复语义 |
| Real CLI smoke | 未执行 | 脚本传参已修复；仍需人工授权后运行 |

## 4. 按严重度排序的问题

### P2-1：Feedback 幂等租约只在内存中，崩溃窗口内可重复发送

`apps/server/src/api/database-ports.ts:213-247` 用 `feedbackLeases: Map` 保护发送；Run 完成的 DB transaction 与 delivery `sentAt` 更新不是同一个持久化状态机。如进程在 Developer Run 已 completed、`markSent` 之前退出，重启后内存 lease 消失，同一 delivery 会被再次发送。解法是持久化 delivery state/idempotency key/lease，并根据已绑定 target run 的 terminal status 决定是拒绝还是可重试。

### P2-2：事件重放与大输出没有容量边界

- `apps/web/src/stores/task-workspace.ts` 每次打开 task 仍从 sequence 0 重放全部事件，长任务首次加载会传输完整历史。
- `streaming-cli.driver.ts` 将成功前的 stderr 无上限放在内存数组；GitService 也会将大型 untracked 文件一次性读入内存。
- DB 同时保存 raw 与 normalized event，没有任务级大小、保留或导出/清理策略。

短任务没问题，长时间 Agent Run 会逐渐变成 UI 卡顿和 DB 膨胀。建议增加分页/虚拟列表、按最大 sequence 增量加载、流式 hash/preview 截断、任务存储统计与可控清理。

### P2-3：数据库 schema 演进仍是手工特判

`apps/server/src/db/database.ts` 用 `CREATE TABLE IF NOT EXISTS` 加一个只处理 task provider columns 的专用 migration。一旦再给旧表增加状态、lease、字段或约束，很容易出现“新库正常、旧库启动后才失败”。建议现在就引入带版本的前向 migration、升级前 backup、migration integration test，而不是等数据库已有真实用户数据再做。

### P2-4：Review 结果契约还缺少跨字段不变量

`packages/shared/src/index.ts:129-141` 只校验行号为正整数，没有校验 `endLine >= startLine`、行号与 file 是否成组出现。现有名为“invalid line range”的测试只覆盖 `startLine = 0`。建议加 `superRefine` 和真正的逆序/缺半区间测试，并在跳转 Diff 前确认 finding file 存在于当前 snapshot。

## 5. 建议的修复顺序

### 第 0 阶段：先恢复可信基线

1. 建立 CI，防止下一次依赖或 UI 行为变更再与验证文档漂移。

### 第 1 阶段：交付前确认

1. 实际运行真实 CLI smoke（脚本传参已修复）；未获得人工授权前继续明确标记为未执行。

### 第 2 阶段：多轮工作流正确性

1. 持久化 feedback delivery 的幂等状态。

### 第 3 阶段：可演进性与性能

1. 正式 migration 与 DB backup。
2. event 分页/虚拟化、diff 与 untracked 读取上限、存储统计。
3. 修整 provider registry 的真实扩展点：当前 `Provider` Zod enum、DB enum、CLI setting key 和前端展示仍需多处同步，还没有达到“只加 driver + registry entry”。

## 6. 功能增强建议

以下排序以“用户价值 / 实现风险”为主，建议与可靠性维护保持清晰边界。

### 高价值、近期可做

1. **Task/Review 模板**
   保存常用的任务验收模板和 Review Profile（正确性、安全、性能、API 兼容、指定目录、自定义规则），并在 Run 上固化当时的 profile 版本，便于重现。
2. **可视化的 feedback delivery 状态**
   在历史中显示 draft/reserved/running/sent/failed/retryable，标明 source review 与 target developer run，并提供明确的“重试原 delivery”而不是让用户猜是否已发送。
3. **任务级 model / reasoning / 额度预算**
   Settings 已能检测当前模型，下一步可允许新 Task 固化 model、reasoning effort、最大轮次/时间/使用量预算，老 Task 不随全局设置漂移。
4. **更好的 Diff UX**
   加入文件树、搜索、变更类型过滤、Finding 上/下一个、行内人工评论、大文件截断标记，并清楚区分“base 后已 commit”与“当前未提交”。

### 中期优先

1. **Worktree 隔离**
   这是 Flint 最自然的下一个大能力：为每个 Task 建立明确的隔离目录，可解决既有 dirty changes 与 Agent 变更混杂、同项目多 Task 不能并行、完成后难以清理的问题。
2. **Task checkpoint / 可恢复节点**
   在每次 Developer Run 前记录 snapshot metadata，提供“比较”而不是自动 reset；任何恢复都必须人工确认，不代替 Git。
3. **Review 对比与 Finding lifecycle**
   将多轮 findings 标记为 new / persisted / resolved / regressed，让用户一眼看出修复是否有效；匹配不应只靠文本，可结合 file/range/fingerprint。
4. **桌面壳与原生目录选择器**
   当本地 Web 版稳定后，桌面壳能解决手输绝对路径、原生单实例体验、托盘、自动启动与日志定位。
5. **导出可审计报告**
   导出 Task 的 prompt、Run timeline、diff stat、review findings、人工选择/备注、实际发送 feedback 与最终状态，适合归档或后续贴到 PR。

### 稳定后再做

- GitHub/GitLab PR 发布与 review comment 同步；
- 多 Reviewer 顺序/并行评审与 finding 去重；
- 真正可插拔的 Provider adapter/ACP；
- 跨设备同步或远程服务。这会改变当前“loopback + 无用户系统”的安全假设，需要独立 threat model，不应当作普通功能增量。

## 7. 建议由项目所有者确认的决策

这个选择不影响本次 review 结论，可以休息后再定（Create 语义和 Agent 输出保留策略均已确定并落地）：

1. **下一个产品主线是可用性还是隔离性**：Diff UX 还是 Worktree？
   `@file` 已完成。我建议在可靠性维护之后优先做 Worktree，再继续扩展 Diff UX。

## 8. 简短总评

Flint 最难得的地方是，它不是“把两个 CLI 用管道接在一起”，而是已经开始认真建模人工决策点、session、snapshot、事件、恢复和安全边界。这是对的产品骨架。P0/P1 修复后，剩余问题已经从核心运行时安全与历史可用性收敛到幂等、容量治理和可演进性。

继续把持久化幂等与容量边界收紧，这个项目就会从“令人惊喜的原型”迈进“可以放心长期用的本地 Agent 工作台”。
