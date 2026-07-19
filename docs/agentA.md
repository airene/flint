# Flint 整体 Code Review

> 审查日期：2026-07-19
> 审查基线：`251b3eb chore project refactor`
> 范围：架构、服务端、Web UI、共享契约、Git/Agent 运行时、安全边界、持久化、测试与交付链路。
> 约束：本次只修改本文件，未修改任何代码、配置或测试。
> 更新（2026-07-19）：P0-1（Reviewer 严格只读）、P1-1（Create & start 语义与 E2E）、P1-2（smoke 传参）、P1-3（TS 工具链）、P1-4（逐 Review feedback draft）、P1-6（base-relative Git 文件清单）、P1-7（Agent/Review 持久化脱敏）以及 P2-2 中前端去重/排序/内存上限部分已修复，相关内容已从本文移除；其余编号保持原状，故存在空缺。

## 1. 结论先行

Flint 不像一个只写了一天的普通原型：产品边界清楚，共享契约、状态机、事件持久化、WebSocket replay、精确 session 恢复、Git snapshot、Fake CLI 和完整的人工 feedback gate 都已经成型。当前 148 项 Bun 测试全部通过，核心域模型的基础质量是好的。

但现在还不建议把它宣称为“安全可交付的 MVP”，原因有两类：

1. **一个核心安全不变量尚未真正成立**：服务崩溃/重复启动时可能留下孤儿 Agent 进程并释放写锁。
2. **一个会在真实使用中遇到的正确性问题**：历史页仍被 Git 实时状态绑死，repository 不可用时持久化历史也无法阅读。

我的总体建议是：**暂停加新 provider/大功能，先用一个“Safety & Reliability”短周期把 P0/P1 清零**。这些修复会让后续的 worktree、桌面端、GitHub 集成和更多 Agent 变得容易，而不是继续放大当前的运行时风险。

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
| `bun test` | **148 pass / 0 fail** | 在允许 loopback 临时端口后，全部 22 个测试文件通过 |
| 不需要端口的 focused tests | **122 pass / 0 fail** | core、Git、Agent、Review、Web 纯逻辑全绿 |
| server/web/shared 源码单独 `tsc --noEmit` | 通过 | 不包含 shared test 与 Vue template 的局部类型检查 |
| `bun run typecheck` | 通过（2026-07-19 修复后） | shared 补 bun types；TypeScript 锁定 5.9.3；`scripts/**` 已纳入检查 |
| `bun run build` | 通过（2026-07-19 修复后） | shared 显式 `rootDir`；TS 回退 5.9.3 后 `vue-tsc` 恢复兼容 |
| server bundle | 通过 | Bun 成功 bundle 225 modules |
| `bun run test:e2e` | 通过 9 pass / 0 fail（2026-07-19 修复后） | 覆盖 Create & start 与逐 Review draft 隔离/恢复语义 |
| Real CLI smoke | 未执行 | 脚本传参已修复；仍需人工授权后运行 |

## 4. 按严重度排序的问题

### P0-2：Run 恢复没有“进程归属/租约”，崩溃或重复启动可以释放仍在写的 Run

**证据**

- `apps/server/src/drivers/streaming-cli.driver.ts:71-83` 用 `detached: true` 启动 Agent，这方便终止进程组，但也意味着服务进程被 `kill -9`/崩溃后子进程可能继续运行。
- `apps/server/src/api/application.ts:244-246` 每次创建 application 都无条件把数据库里的活动 Run 恢复为 interrupted。
- `apps/server/src/api/database-ports.ts:315-341` 恢复时只改数据库状态并清空 PID，没有证明原进程已终止，也没有 owner instance/heartbeat/lease。
- `apps/server/src/index.ts:5-12` 先 `createApplication()` 再绑定端口。因此用户误启第二个 Flint 时，它即使稍后因端口冲突退出，也已经把第一个实例的活动 Run 标记成 interrupted。
- `apps/server/src/api/database-ports.ts:142-149` 的 terminal update 没有 owner/status compare-and-set，旧进程后来结束时还可再覆盖 Run/Task 状态。

**影响**

最坏路径是：旧 Agent 仍在修改 repository → 新 Flint 将其写锁释放 → 用户启动新 Developer → 同一 project 出现两个写进程，并且两个 terminal 结果互相覆盖。这破坏了项目级单写 Run 的核心不变量。

**建议**

- 在打开/恢复数据库前获取单实例锁；至少要保证“新实例未成为唯一 owner 前不做 recovery”。
- 为 Run 持久化 `ownerInstanceId + lease/heartbeat`；`markRunning/succeed/fail/recover` 都使用 owner 和当前 status 做 CAS。
- 解决 parent-death 行为：用 watchdog/supervisor 让父进程断开后子进程组被可靠终止；各平台分别验证。
- 增加两类测试：同 DB 双 application 竞争；父进程强制退出后子进程不再心跳/修改 repository。

### P1-5：持久化的 Task/Run 历史被实时 Git 读取绑死

**证据**

- `apps/web/src/stores/task-workspace.ts:139-154` 在一个 `Promise.all` 里同时请求 task、runs、findings 和 Git status，随后还要成功读取首个 file diff，才将 `task.value` 设置为已加载。
- repository 被移动/删除、Git executable 失效，或 Agent 恰好在 status 与 file-diff 两次请求间改变文件时，整个 task 页会进入 `Task unavailable`，即使 DB 中的历史完好无损。
- `apps/server/src/api/application.ts:275-279` 只在注册 project 前做 `requireCli("git")`；创建 task、review、feedback snapshot 与 Git API 均可把 Git 不可用映射成泛化 500，而不是契约中的 `422 CLI_UNAVAILABLE`。

**建议**

- 页面采用两阶段加载：先渲染持久化 task/runs/findings/events，再独立加载可失败的实时 repository panel。Git 失败应显示“history 仍可读，repository 当前不可用”。
- status/file-diff 竞态应只清空当前 Diff 并请求一次有界重试，不要使 task 失败。
- 服务端所有 Git-dependent route/action 统一做 availability/error mapping。

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

### 第 1 阶段：安全阻断项

1. 引入 application owner + Run lease + parent-death 管理，然后做双实例和崩溃恢复测试。
2. 实际运行真实 CLI smoke（脚本传参已修复）；未获得人工授权前继续明确标记为未执行。

### 第 2 阶段：多轮工作流正确性

1. 持久化 feedback delivery 的幂等状态。
2. 历史数据与实时 Git panel 解耦，Git 错误统一映射。

### 第 3 阶段：可演进性与性能

1. 正式 migration 与 DB backup。
2. event 分页/虚拟化、diff 与 untracked 读取上限、存储统计。
3. 修整 provider registry 的真实扩展点：当前 `Provider` Zod enum、DB enum、CLI setting key 和前端展示仍需多处同步，还没有达到“只加 driver + registry entry”。

## 6. 功能增强建议

以下排序以“用户价值 / 实现风险”为主，不建议跳过上面的 Safety & Reliability 周期直接开做。

### 高价值、近期可做

1. **`@file` 提及与上下文预览**
   repository 已经有 `docs/superpowers/specs/2026-07-19-file-mentions-design.md`，设计方向很好，应作为下一个纯产品功能优先实现。建议在候选项里同时显示 tracked/untracked 标记，但仍只向 prompt 插入相对路径。
2. **Task/Review 模板**
   保存常用的任务验收模板和 Review Profile（正确性、安全、性能、API 兼容、指定目录、自定义规则），并在 Run 上固化当时的 profile 版本，便于重现。
3. **可视化的 feedback delivery 状态**
   在历史中显示 draft/reserved/running/sent/failed/retryable，标明 source review 与 target developer run，并提供明确的“重试原 delivery”而不是让用户猜是否已发送。
4. **任务级 model / reasoning / 额度预算**
   Settings 已能检测当前模型，下一步可允许新 Task 固化 model、reasoning effort、最大轮次/时间/使用量预算，老 Task 不随全局设置漂移。
5. **更好的 Diff UX**
   加入文件树、搜索、变更类型过滤、Finding 上/下一个、行内人工评论、大文件截断标记，并清楚区分“base 后已 commit”与“当前未提交”。

### 中期优先

1. **Worktree 隔离**
   这是 Flint 最自然的下一个大能力：为每个 Task 建立明确的隔离目录，可解决既有 dirty changes 与 Agent 变更混杂、同项目多 Task 不能并行、完成后难以清理的问题。但应在 P0-2 的 owner/lease 完成之后再做。
2. **Task checkpoint / 可恢复节点**
   在每次 Developer Run 前记录 snapshot metadata，提供“比较”而不是自动 reset；任何恢复都必须人工确认，不代替 Git。
3. **Review 对比与 Finding lifecycle**
   将多轮 findings 标记为 new / persisted / resolved / regressed，让用户一眼看出修复是否有效；匹配不应只靠文本，可结合 file/range/fingerprint。
4. **桌面壳与原生目录选择器**
   当本地 Web 版稳定后，桌面壳能解决手输绝对路径、单实例锁、托盘、自动启动与日志定位。这不只是包装，也能改善 P0-2 的进程所有权问题。
5. **导出可审计报告**
   导出 Task 的 prompt、Run timeline、diff stat、review findings、人工选择/备注、实际发送 feedback 与最终状态，适合归档或后续贴到 PR。

### 稳定后再做

- GitHub/GitLab PR 发布与 review comment 同步；
- 多 Reviewer 顺序/并行评审与 finding 去重；
- 真正可插拔的 Provider adapter/ACP；
- 跨设备同步或远程服务。这会改变当前“loopback + 无用户系统”的安全假设，需要独立 threat model，不应当作普通功能增量。

## 7. 建议由项目所有者确认的决策

这个选择不影响本次 review 结论，可以休息后再定（Create 语义和 Agent 输出保留策略均已确定并落地）：

1. **下一个主线是可用性还是隔离性**：`@file`/Diff UX 还是 Worktree？
   我建议先完成小而高频的 `@file`，紧接着做 Worktree；但两者都应排在 P0/P1 清零之后。

## 8. 简短总评

Flint 最难得的地方是，它不是“把两个 CLI 用管道接在一起”，而是已经开始认真建模人工决策点、session、snapshot、事件、恢复和安全边界。这是对的产品骨架。当前主要问题不是方向错，而是几个核心承诺还只做到了“正常路径成立”，尚未做到“对抗、崩溃和多轮路径也成立”。

先把 Run 所有权和持久化历史与实时 Git 状态的耦合修好，这个项目就会从“令人惊喜的原型”迈进“可以放心长期用的本地 Agent 工作台”。
