# Local Pair Review MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库实现一个可在本机完成“Codex 开发 → Claude 只读 Review → 人工筛选反馈 → 原 Codex Session 修复”闭环的 MVP。

**Architecture:** 单 Bun 服务进程 + Vue 前端。按 Phase 0-5 依次交付：先建立工程骨架和共享契约，再实现核心数据与 Git、Agent Runtime 与 Review、API/WebSocket 总装和 Web UI，最后统一加固并完成端到端验收。

**Tech Stack:** Bun >= 1.3、TypeScript、Vue 3、Vite、Pinia、Vue Router、Monaco、`Bun.serve()`、Bun WebSocket、`Bun.spawn()`、SQLite、Drizzle ORM、Zod、Playwright。

**Source of Truth:** [001-spec.md](./001-spec.md) 是唯一需求来源。本计划只定义实施顺序和验收门槛；任何冲突以 spec 为准。

## Global Constraints

- 服务默认且仅监听 `127.0.0.1`，MVP 不提供公网访问。
- 所有子进程使用参数数组和显式 `cwd`，禁止 Shell 字符串和 `process.chdir()`。
- Codex 默认使用 `--sandbox workspace-write`；Claude Reviewer 必须在 CLI 权限层只读。
- 精确保存和恢复 Session ID，禁止依赖 `--last` 或 `--continue`。
- Agent 事件先持久化再广播；未知 CLI 事件必须保存为 `raw`。
- 同一 Project 同时最多一个写 Run；Review 只能在写 Run 停止后启动。
- Claude Findings 不得自动发送给 Codex，必须经过人工选择和编辑。
- 启动 CLI 子进程时无条件移除环境副本中的显式 API 凭证变量；不修改父进程环境，不保存或输出凭证。
- Real CLI Smoke Test 不进入默认 CI，必须由开发者显式确认。
- MVP 不实现自动循环、自动 Commit/PR、Worktree 管理、ACP、远程访问或用户系统。

## 执行模型

默认单 Agent 按 Phase 0 → 1 → 2 → 3 → 4 → 5 串行执行，每个 Phase 以其 Verification 命令通过作为完成条件。

Phase 1 与 Phase 2 目录互斥，需要缩短周期时可以交给两个 Worker 并行；并行期间双方都不修改 `packages/shared/**` 和 `apps/server/src/db/schema.ts`，契约不足先记录下来，在 Phase 3 开始前统一处理；Phase 2 中依赖 Phase 1 产物的接线（如 Task 状态回退调用）留到两者都完成后进行。除此之外不需要额外的协调流程。

共享契约在 Phase 0 定稿。后续 Phase 确需修改契约时，在同一次改动中同步更新类型、Zod Schema、Drizzle Schema 和受影响的调用方；禁止在别处复制类型绕过 `packages/shared`。

---

## Phase 0 — 工程骨架与共享契约

**Files:**

- 根目录 Bun workspace、`bunfig.toml`、`tsconfig*.json`
- `apps/server`、`apps/web`、`packages/shared` 骨架
- `apps/server/src/db/schema.ts`
- 基础测试配置

**Produces:**

- 可安装、可类型检查、可测试、可构建的空工程；
- 领域类型、Zod Schema（含 Review Schema）、API DTO、AgentEvent 和错误响应契约；
- Drizzle 表、索引和唯一约束定义；
- AgentDriver 接口；
- 最小 `/api/health`、WebSocket 握手和前端启动页。

- [ ] 初始化 Bun workspace、Server、Vue/Vite 应用和 `packages/shared`。
- [ ] 把 spec 中的 Project、Task、AgentRun、ReviewFinding、FeedbackDelivery、AgentEvent、Review Schema 和错误类型写入 shared。
- [ ] 建立 Zod Schema 与 Drizzle Schema，明确 task-scoped event sequence 和并发唯一约束。
- [ ] 定义 AgentDriver、HTTP DTO、WebSocket subscribe/event 契约。
- [ ] 建立最小 `/api/health`、WebSocket 握手和前端启动页。

**Verification:**

```bash
bun install
bun run typecheck
bun test
bun run build
```

**Expected outcome:** 四条命令成功；服务端和 Web 应用可以独立启动；契约只在 shared 定义一份。

## Phase 1 — 核心数据与 Git

**Files:** `apps/server/src/db/database.ts`、`apps/server/src/services/{project,task,git}.service.ts`、`apps/server/src/utils/path*.ts`、`tests/core/**`、`tests/git/**`

**Produces:**

- SQLite 连接与启动建表（首版直接建表，不引入迁移框架）；
- Project 添加、去重、列出、切换和移除（含历史数据级联删除的确认数据）；
- canonical Git root 与路径验证；
- Task 创建、状态转换和异常回退函数；
- tracked、staged、untracked、binary Diff 与 Diff Stat；
- 稳定 Snapshot Hash；
- Project 级写 Run 冲突检查所需查询。

- [ ] 实现数据库初始化与建表；Service 直接使用 Drizzle 访问数据，不加 Repository 层。
- [ ] 实现 Project、Task 和 Git Services。
- [ ] 实现 canonical path、脏工作区确认数据和 Snapshot Hash。
- [ ] 用临时 Git 仓库覆盖 clean/dirty、tracked/staged/untracked、删除、二进制和 Snapshot 过期；覆盖 Task 异常回退。

**Verification:**

```bash
bun test tests/core tests/git
bun run typecheck
```

## Phase 2 — Agent Runtime 与 Review

**Files:** `apps/server/src/drivers/**`、`apps/server/src/services/{agent-run,event,review,feedback}.service.ts`、`apps/server/src/utils/process*.ts`、`apps/server/src/utils/redact*.ts`、`tests/agents/**`、`tests/review/**`、`tests/fixtures/bin/**`

**Produces:**

- Codex/Claude/Git 可用性检测（安装、版本、登录状态）；
- Codex JSONL、Claude stream-json 容错 Parser；
- AgentRun 生命周期、Session ID 立即持久化、取消（子进程树 + 宽限期）与退出分类；
- task-scoped event 持久化与广播输出；
- Claude Review Prompt、结构化结果 Zod 校验和 Finding 生成；解析失败保留原始输出；
- Feedback Composer、FeedbackDelivery 与精确 Codex Session resume（含重复发送保护）；
- 子进程环境凭证过滤与日志脱敏；
- Fake CLI fixtures：正常、失败、慢流、未知事件、非法 JSON、非零退出、中途终止和取消。

- [ ] 实现 CLI 环境构造（无条件移除显式 API 凭证变量）、参数数组和可用性检测。
- [ ] 实现两个 Driver 与两个容错 Parser。
- [ ] 实现 AgentRun、Event、Review 和 Feedback 服务，接入 Task 状态回退。
- [ ] 实现 Fake CLI fixtures 并覆盖上述全部场景。

**Verification:**

```bash
bun test tests/agents tests/review
bun run typecheck
```

**Expected outcome:** 不调用真实订阅即可验证 Session、事件、结构化 Review、解析失败、非零退出、取消和 resume 参数；未知事件不丢失；测试输出不包含模拟 Token。

## Phase 3 — HTTP API 与 WebSocket 总装

**Files:** `apps/server/src/index.ts`、`apps/server/src/config.ts`、`apps/server/src/api/**`

**Produces:** 使用真实 SQLite、Services、Drivers 和 WebSocket 的可运行本地服务。

- [ ] 实现全部 HTTP routes、统一错误映射和 `409` 并发冲突（事务内检查写锁）。
- [ ] 实现 task-scoped WebSocket replay（`afterSequence` 补发）与实时广播。
- [ ] 实现启动恢复：`queued`/`running` Run 标记为 `interrupted`、清空失效 PID、按 spec 回退 Task。
- [ ] 实现服务关闭行为：停止新任务、终止活动进程树、标记 Run、关闭 WebSocket 和 SQLite。
- [ ] 用 Fake CLI 对真实 Server 完成 Codex → Review → Feedback 闭环的 API 级测试。

**Verification:**

```bash
bun run typecheck
bun test
bun run build
```

## Phase 4 — Web UI

**Files:** `apps/web/**`

开发直接对 Phase 3 的真实 Server + Fake CLI 进行，不建 mock transport。

**Produces:**

- typed API client、Pinia stores 和 Router；
- Project/Task 页面、CLI 状态与设置页面；
- Codex、Activity、Claude Review 和 Monaco Diff 面板；
- WebSocket 订阅、`afterSequence` 补发与 `(taskId, sequence)` 去重；
- Finding 批量/单项选择、忽略、备注和 Feedback Editor；
- 所有 Task 状态的操作按钮与错误/恢复 UI：CLI 缺失/未登录、取消、失败回退、解析失败、Snapshot 过期确认。

- [ ] 建立 typed API client、Pinia stores 和 Router。
- [ ] 实现 Project/Task 主流程及状态驱动操作。
- [ ] 实现 Activity、Review、Diff 和 Feedback 组件。
- [ ] 对真实 Server + Fake CLI 人工走通完整流程，含浏览器刷新恢复。

**Verification:**

```bash
bun run typecheck
bun run build
bun run dev   # 人工走通闭环
```

## Phase 5 — 加固、E2E 与交付

**Files:** `tests/e2e/**`、`README.md`、`scripts/**`，以及为修复问题而需要改动的既有文件

**Produces:**

- 重启恢复、并发写锁与重复请求防护测试；
- 大 Diff、二进制、未跟踪文件等 Git 边界处理；
- 数据库写失败处理（暂停广播、终止对应 Run）；
- Playwright E2E：happy path + 刷新恢复 + 一条失败路径；
- README 与 Real CLI Smoke Test 脚本。

- [ ] 补齐进程中断后的持久化恢复、并发写锁和 Git 边界测试。
- [ ] 补齐取消、崩溃、异常流结束和数据库写失败行为测试。
- [ ] Playwright 覆盖 happy path（添加项目 → 开发 → Review → 选择 Finding → 反馈 → 完成）、刷新恢复和一条失败路径；其余状态转换由单元测试覆盖。
- [ ] 检查所有 spawn 调用均为参数数组且使用正确 `cwd`；日志、错误响应和 fixture 不含真实凭证或绝对用户路径。
- [ ] README 写明安装、CLI 登录、开发命令、数据目录、权限模型和已知 MVP 限制；记录验证所用 Bun/Codex/Claude/Git 版本。
- [ ] 对照 spec 第 19 节逐项签收全部 MVP 验收标准。

**Verification:**

```bash
bun run typecheck
bun test
bun run test:e2e
bun run build
bun run dev
```

人工确认：

- 服务只监听 `127.0.0.1`；
- 可以添加至少三个临时 Git 项目并切换；
- 一个项目运行写任务时第二个写请求得到 `409`；
- 浏览器刷新后从 `afterSequence` 恢复事件；
- 重启服务后活动 Run 变为 interrupted，Task 出现恢复入口。

### Real CLI Smoke Test

先显示将使用的 CLI 路径、版本、认证模式和临时仓库路径，并要求开发者确认，再运行：

```bash
bun run smoke:codex
bun run smoke:claude
```

**Expected outcome:**

- Codex 在专用临时 Git 仓库产生 JSONL、Session ID 和可见 Diff；
- 同一 Session 能通过精确 ID 恢复；
- Claude 产生 stream-json、Session ID 和通过 Zod 的结构化结果；
- Claude Review 前后 Snapshot 不变；
- Smoke Test 清理只影响它创建的临时目录。

若开发者不授权消耗订阅，记录 Smoke Test 为“人工未执行”，不能伪装为通过；其余自动验收仍必须完成。

## Definition of Done

只有同时满足以下条件，才能声明 MVP 完成：

- spec 第 19 节全部适用验收标准已签收；
- `typecheck`、全部 Bun tests、Playwright E2E 和 build 通过；
- Fake CLI 覆盖正常、失败、取消、恢复、非法 JSON 和解析失败；
- 数据库与浏览器刷新后数据、事件和 Session 可恢复；
- Reviewer 权限、命令参数数组、路径和环境过滤经过测试；
- 没有自动 Review/反馈循环；
- 没有未说明的占位符、跳过测试或静默降级；
- Real CLI Smoke Test 已通过，或明确记录为等待开发者授权的唯一人工项；
- 最终实现和 README 与 [001-spec.md](./001-spec.md) 一致。
