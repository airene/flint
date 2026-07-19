# Local Pair Review MVP Technical Specification

版本：0.3  
形态：本地 Web 应用  
运行环境：Bun >= 1.3  
实施计划：[001-plan.md](./001-plan.md)

## 1. 决策摘要

Local Pair Review 是一个运行在本机的双 Agent 协作客户端：Codex CLI 负责开发，Claude Code CLI 负责只读 Review，用户筛选和编辑 Review 意见后，再把反馈发送回原 Codex Session。

| 领域 | MVP 决策 |
| --- | --- |
| 应用形态 | 仅监听 `127.0.0.1` 的本地 Web 应用 |
| Runtime | Bun + TypeScript |
| 前端 | Vue 3 + Vite + Pinia + Vue Router + Monaco |
| 服务端 | `Bun.serve()` + Bun WebSocket + `Bun.spawn()` |
| 数据库 | SQLite (`bun:sqlite`) + Drizzle ORM |
| Developer | Codex CLI 的 `codex exec --json` |
| Reviewer | Claude Code CLI 的 `claude -p --output-format stream-json` |
| 认证 | 复用用户已登录的 CLI 订阅账号，不保存 API Key |
| 协作方式 | 人工选择、编辑并发送 Review 意见，不自动循环 |
| 项目隔离 | 每个子进程显式设置 `cwd`，应用禁止调用 `process.chdir()` |
| 同项目并发 | 一个 Project 同时最多一个写 Run；Review 期间不得有写 Run |
| CLI 兼容 | 启动时检测 CLI 安装、版本与登录状态；未知事件保留为 `raw` |

## 2. 产品定位

### 2.1 核心流程

```text
选择本地 Git 项目
  → 创建开发任务
  → Codex 在项目目录中修改代码
  → 用户确认后启动 Claude 只读 Review
  → Claude 返回 P0 / P1 / P2 Findings
  → 用户选择并编辑最终反馈
  → 反馈发送回原 Codex Session
  → Codex 继续修改
  → 用户再次 Review 或标记完成
```

Claude 的 Review 结果永远不会自动发送给 Codex。P0、P1 默认选中，P2 默认不选中，用户可以修改选择、人工备注和最终发送文本。

### 2.2 非目标

MVP 不是：

- 通用 Agent Workflow 平台；
- 自动 Review 循环；
- IDE、终端模拟器或代码托管平台；
- 多租户或远程服务；
- Codex/Claude 的二次实现；
- Agent-to-Agent 通信协议。

## 3. MVP 范围

MVP 必须支持：

1. 检测 Codex、Claude 和 Git CLI；
2. 添加、移除和切换多个本地 Git 项目；
3. 为项目创建开发任务并记录基准提交；
4. 启动、取消和恢复 Codex 开发 Run；
5. 实时展示并持久化 Codex JSONL 事件；
6. 立即保存精确的 Codex Session ID；
7. 展示 tracked、staged 和 untracked 变更；
8. 启动受权限约束的 Claude 只读 Review；
9. 实时展示并持久化 Claude stream-json 事件；
10. 把 Review 解析为 P0、P1、P2 Findings；
11. 在结构化解析失败时保留原始 Review；
12. 按严重级别批量选择或单独选择 Finding；
13. 添加人工备注并编辑最终反馈；
14. 把反馈发送回精确的原 Codex Session；
15. 手动再次 Review 或继续向 Codex 发送消息；
16. 应用重启后恢复项目、任务、日志和 Session 信息；
17. 检测 Review Snapshot 是否过期；
18. 防止同一项目出现并发写 Run；
19. 手动标记任务完成。

MVP 明确不实现：自动合并、自动 Commit、自动 PR、GitHub/GitLab 集成、自动 Worktree、同项目多写任务并行、云同步、用户系统、远程访问、第三个 Planner Agent、ACP、Docker Sandbox、桌面包装和插件市场。

## 4. 系统架构

```text
Vue Web UI
  ├── Project / Task
  ├── Codex Activity
  ├── Git Diff
  ├── Claude Review
  └── Feedback Editor
          │ HTTP + WebSocket
          ▼
Bun Local Server
  ├── Project / Task / Git Services
  ├── Agent Run / Event / Review Services
  ├── SQLite 持久化（Drizzle）
  └── AgentDriver Registry
          ├── CodexCliDriver  → codex exec
          └── ClaudeCliDriver → claude -p
```

主应用只有一个 Bun 服务进程。每个 Agent Turn 和 Git 操作创建短生命周期子进程。每个子进程必须使用任务自己的 `workingDirectory` 作为 `cwd`。

### 4.1 组件边界

```text
apps/server       HTTP、WebSocket、服务、持久化、Driver、Parser、Feedback Composer
apps/web          Vue UI、Router、Pinia Store、API Client
packages/shared   领域类型、API/事件契约、Zod Schema（含 Review Schema 与严重级别）
tests             单元、Fake CLI、Git 集成和 Web E2E
```

共享契约是服务端和前端的唯一公共接口来源，不能在两端复制定义。

### 4.2 数据目录

```text
~/.local-pair-review/
├── data/app.db
└── logs/
```

应用设置（如自定义 CLI 可执行文件路径）保存在数据库 `app_settings` 表中。应用不保存 CLI Token、Cookie、API Key 或 Keychain 内容。

## 5. 核心领域模型

以下接口表达契约；持久化层可以使用等价的 snake_case 字段。

### 5.1 Project

```ts
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}
```

`rootPath` 必须是经过 `realpath()` 解析、由 `git rev-parse --show-toplevel` 得到的 canonical Git 根目录。同一 canonical `rootPath` 只能注册一次。移除 Project 不得删除本地文件。

### 5.2 Task

```ts
export type TaskStatus =
  | "draft"
  | "developing"
  | "ready_for_review"
  | "reviewing"
  | "waiting_for_human"
  | "fixing"
  | "completed";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  originalPrompt: string;
  workingDirectory: string;
  baseCommit: string;
  latestSnapshotHash: string | null;
  status: TaskStatus;
  developerProvider: "codex" | "claude";
  reviewerProvider: "codex" | "claude";
  developerSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

Task 状态描述产品工作流。失败、取消和中断属于具体 AgentRun，不能把 Task 留在没有恢复入口的 `failed` 或 `interrupted` 状态。

`workingDirectory` 在 MVP 中等于 Project 的 canonical `rootPath`。`baseCommit` 在创建任务时必须存在，项目无 `HEAD` 时拒绝创建任务并给出说明。

Task 保存开发者 CLI 返回的精确 `developerSessionId`，用于后续 Feedback Run 恢复同一开发会话。Reviewer 每轮严格只读且独立启动，其 Session ID 仅记录在对应 AgentRun 的 `externalSessionId` 中，不跨轮恢复。恢复开发会话必须使用精确 Session ID，禁止依赖 `--last` 或 `--continue`。

### 5.3 AgentRun

```ts
export type AgentRunType =
  | "developer_initial"
  | "developer_feedback"
  | "reviewer";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ReviewParseStatus =
  | "pending"
  | "succeeded"
  | "failed";

export interface AgentRun {
  id: string;
  taskId: string;
  projectId: string;
  provider: "codex" | "claude";
  runType: AgentRunType;
  status: AgentRunStatus;
  reviewParseStatus: ReviewParseStatus | null;
  externalSessionId: string | null;
  processId: number | null;
  exitCode: number | null;
  prompt: string;
  finalMessage: string | null;
  structuredOutput: unknown | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
```

`reviewParseStatus` 仅用于 reviewer Run，其他 Run 保持 `null`。

Reviewer 进程正常结束但结构化结果解析失败时：

- `status = "completed"`；
- `reviewParseStatus = "failed"`；
- 保存原始输出并把 Task 转为 `waiting_for_human`；
- 页面允许用户查看、复制和编辑原始 Review；
- 不自动生成 Finding。

### 5.4 ReviewFinding

```ts
export type ReviewSeverity = "P0" | "P1" | "P2";

export interface ReviewFinding {
  id: string;
  taskId: string;
  runId: string;
  severity: ReviewSeverity;
  title: string;
  description: string;
  suggestion: string;
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  selected: boolean;
  dismissed: boolean;
  userNote: string | null;
  createdAt: string;
}
```

默认值：`selected = severity === "P0" || severity === "P1"`。

### 5.5 FeedbackDelivery

发送给 Codex 的内容必须单独持久化：

```ts
export interface FeedbackDelivery {
  id: string;
  taskId: string;
  sourceReviewRunId: string;
  targetDeveloperRunId: string | null;
  selectedFindingIds: string[];
  finalText: string;
  sentAt: string | null;
  createdAt: string;
}
```

## 6. 数据库与一致性约束

MVP 数据表：

```text
projects
tasks
agent_runs
agent_events
review_findings
feedback_deliveries
app_settings
```

关键约束：

- `projects.root_path` 唯一；
- `agent_events(task_id, sequence)` 唯一；
- 一个 Task 同时最多一个 `queued` 或 `running` AgentRun；
- 一个 Project 同时最多一个写类型的 `queued` 或 `running` AgentRun；
- 创建 Run、检查并发锁和更新 Task 状态必须在同一事务中完成；
- 原始 CLI 事件不能因标准化失败而丢失。

`agent_events` 至少保存：

```text
id, task_id, run_id, sequence, source, event_type,
raw_json, normalized_json, created_at
```

`sequence` 是 Task 范围内严格单调递增的序号，由服务端在数据库事务中分配。它不是 Run 内序号，也不是全局序号。

## 7. AgentDriver 契约

```ts
export interface AgentStartRequest {
  runId: string;
  taskId: string;
  projectId: string;
  workingDirectory: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentStartResult {
  sessionId: string | null;
  finalMessage: string | null;
  structuredOutput: unknown | null;
}

export interface AgentAvailability {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  authentication: "unknown" | "authenticated" | "unauthenticated";
  message: string | null;
}

export interface AgentDriver {
  readonly provider: "codex" | "claude";
  checkAvailability(): Promise<AgentAvailability>;
  start(
    request: AgentStartRequest,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<AgentStartResult>;
  cancel(runId: string): Promise<void>;
}
```

Driver 不得自行创建业务 Run ID。`AgentRunService` 先持久化 Run，再把 `runId` 传给 Driver。

### 7.1 CLI 可用性检测

启动和手动重新检测时，应用确认可执行文件存在、版本命令成功，并尽可能判断登录状态。CLI 未安装或明确未登录时禁止启动相应 Run，并显示检测结果和重新检测入口。

实现依赖下列 CLI 行为，但不做逐项 help 解析——help 文本跨版本的变化比行为本身更频繁，逐项探测会让检测器自己成为脆弱点：

- Codex：`exec`、`--json`、`--sandbox workspace-write`、`exec resume <SESSION_ID>`；
- Claude：`-p`、`--output-format stream-json`、`--json-schema`、`--permission-mode plan`、tool allow/deny、`--resume`；
- Git：`rev-parse`、`status`、`diff`、`ls-files`。

这些行为以运行时实际调用结果为准：Run 因 CLI 行为缺失而失败时，保留脱敏后的原始错误并提示重新检测。

已知事件按当前 Parser 处理；未知但合法的 JSON 事件标准化为 `raw`。CLI 输出的新增字段必须被忽略而不是导致整行解析失败。

## 8. CodexCliDriver

### 8.1 初次开发

逻辑命令：

```bash
codex exec --json --sandbox workspace-write -
```

必须用参数数组和 stdin：

```ts
const proc = Bun.spawn(
  [codexPath, "exec", "--json", "--sandbox", "workspace-write", "-"],
  {
    cwd: request.workingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: createCliEnvironment("codex"),
  },
);
```

### 8.2 Session 与恢复

收到 `thread.started.thread_id` 后必须立即在同一业务操作中更新 Task 和 AgentRun 的 Session 字段，不能等 Run 结束。

后续消息使用：

```bash
codex exec resume <SESSION_ID> --json -
```

恢复进程仍使用原 Task 的 `workingDirectory`。

### 8.3 完成判断

完成必须同时满足：

- 收到 `turn.completed`；
- 子进程退出码为 `0`。

`turn.failed`、`error`、非零退出码或 JSONL 异常结束均使 Run 失败。已经产生的事件、输出和 Session ID仍需保留。

## 9. ClaudeCliDriver

### 9.1 Review 执行

逻辑命令：

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --permission-mode plan \
  --json-schema '<REVIEW_SCHEMA>' \
  '<PROMPT>'
```

实现必须用参数数组。Prompt 优先通过 stdin 输入；若当前版本的 `-p` stdin 行为不可用（以 Smoke Test 验证为准），则使用单个参数传递 Prompt，仍不得经过 Shell。

### 9.2 只读权限

Reviewer 只提供读取类能力：

```text
Read
Glob
Grep
Bash(git status *)
Bash(git diff *)
Bash(git log *)
Bash(git show *)
Bash(git ls-files *)
```

至少显式拒绝：

```text
Edit
Write
NotebookEdit
Bash(rm *)
Bash(mv *)
Bash(git reset *)
Bash(git checkout *)
Bash(git clean *)
Bash(git commit *)
Bash(git push *)
```

Prompt 约束不能替代 CLI 权限约束。Review 前后都要重新计算 Snapshot Hash；若代码发生变化，Review 标记过期。

### 9.3 Review 结果

Review Prompt 必须包含：原始任务、基准提交、Git 状态、Diff Stat、评审维度和 P0/P1/P2 定义。要求每个 Finding 独立、尽可能提供文件和行号、无问题时返回空数组。

结构化结果 Schema：

```ts
const reviewResultSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "changes_suggested"]),
  findings: z.array(z.object({
    severity: z.enum(["P0", "P1", "P2"]),
    title: z.string(),
    description: z.string(),
    suggestion: z.string(),
    file: z.string().nullable(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  }).strict()),
}).strict();
```

在 `stream-json` 中，服务端持续保存事件，并从最终 `result` 消息读取 `session_id`、最终文本和 `structured_output`。`structured_output` 必须再经过 Zod 校验。Parser 不得假设结构化对象会出现在普通 assistant 文本中。

MVP 每次 Review 创建新 Claude Session，但仍保存其精确 Session ID。Reviewer Session 恢复不是 MVP 必需路径。

## 10. 统一事件与 WebSocket

```ts
export interface AgentEvent<T = unknown> {
  sequence: number;
  timestamp: string;
  projectId: string;
  taskId: string;
  runId: string;
  source: "codex" | "claude" | "system" | "git";
  type: AgentEventType;
  payload: T;
}
```

事件类型至少覆盖：Run 生命周期、Session 创建、Turn 生命周期、消息、Plan、工具、命令、文件变化、Usage、stderr、Review 解析结果和 `raw`。

连接地址：`ws://127.0.0.1:<port>/ws`。

订阅：

```json
{"action":"subscribe","taskId":"task_xxx","afterSequence":16}
```

服务端先从 SQLite 补发 `sequence > afterSequence` 的历史事件，再推送实时事件。前端必须按 `(taskId, sequence)` 去重。CLI 事件必须先写入 SQLite 再广播；慢客户端不得阻塞 CLI stdout 读取，服务端可以直接断开积压过多的连接，客户端重连后通过 `afterSequence` 补发。

## 11. Project、Task 与 Git

### 11.1 添加项目

服务端验证：目录存在、`realpath()` 成功、是 Git 仓库、Git 可执行、canonical 根目录未注册。用户选择仓库子目录时，最终注册 Git 顶层目录。

移除 Project 时，如果没有历史 Task，可以直接删除应用内记录；如果存在历史 Task，必须二次确认后在一个事务中删除该 Project 的应用内 Task、Run、Event、Review 和 Feedback 记录。两种情况都不得删除本地目录、Git 数据或 CLI 自身保存的 Session。

### 11.2 创建任务

创建时保存 `git rev-parse HEAD` 为 `baseCommit`，并读取 `git status --porcelain`。存在未提交变更时必须明确警告并要求确认：这些变化会与 Agent 修改一起进入 Review。

MVP 不自动 stash、commit 或隔离既有变更。因此 `baseCommit` 不是“仅 Agent 变更”的边界，这是明确的 MVP 限制。

### 11.3 Diff

Diff 必须覆盖：

- `git diff <baseCommit> --`；
- `git diff --cached <baseCommit> --`；
- `git ls-files --others --exclude-standard`；
- `git diff --stat <baseCommit> --`。

未跟踪文本文件生成 `/dev/null` 到新文件的展示 Diff；二进制文件仅显示 added/changed。所有 Git 调用使用参数数组。

### 11.4 Snapshot Hash

Review Snapshot 输入至少包括：`baseCommit`、tracked diff、staged diff、未跟踪路径和未跟踪内容摘要。输入必须使用稳定排序和无歧义编码。

Review 结束后再次计算。不同则标记过期；Finding 仍可查看，但发送反馈前必须二次确认。

## 12. 状态转换与恢复

正常流程：

```text
draft → developing → ready_for_review
ready_for_review → reviewing → waiting_for_human
ready_for_review → completed     （确认后跳过 Review）
waiting_for_human → fixing → ready_for_review
waiting_for_human → reviewing
waiting_for_human → completed
ready_for_review → fixing        （直接继续 Codex Session）
```

Run 异常后的 Task 回退：

| Run | failed / cancelled / interrupted 后的 Task 状态 |
| --- | --- |
| developer_initial | 有 Session ID 或工作区已变化则 `ready_for_review`，否则 `draft` |
| developer_feedback | `ready_for_review` |
| reviewer | `ready_for_review` |
| reviewer 仅解析失败 | `waiting_for_human`，显示原始 Review |

应用启动时把数据库中所有 `queued`、`running` Run 标记为 `interrupted`，清空失效 PID，按上表回退 Task。保留可恢复的开发者 Session ID，并提供“恢复开发会话”或“重新 Review”。

用户取消 Run 时先发送终止信号，等待有限宽限期，再终止整个子进程树。最终状态为 `cancelled`；服务关闭或进程归属丢失使用 `interrupted`。

## 13. Feedback

Feedback Preview 由选中的 Finding 按 Review 顺序生成，至少包含：原始任务、严重级别、标题、文件/行号、问题、建议和人工备注。

用户可以：选择 P0、选择 P0+P1、全部选择、全部取消、单项选择、忽略、添加备注、跳转 Diff，并编辑最终文本。

发送时先创建 FeedbackDelivery，再使用精确 Codex Session ID 启动 `developer_feedback` Run。若进程未成功启动或失败，保留 Delivery 草稿并允许重试，不能静默重复发送。

## 14. HTTP API

```text
GET  /api/health
GET  /api/system/clis
POST /api/system/clis/recheck

GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId  # 仅记录 lastOpenedAt
DELETE /api/projects/:projectId

GET   /api/projects/:projectId/tasks
POST  /api/projects/:projectId/tasks
GET   /api/tasks/:taskId
POST  /api/tasks/:taskId/complete

POST /api/tasks/:taskId/develop
POST /api/tasks/:taskId/review
POST /api/tasks/:taskId/feedback
POST /api/runs/:runId/cancel
GET  /api/runs/:runId
GET  /api/tasks/:taskId/runs

GET /api/tasks/:taskId/git/status
GET /api/tasks/:taskId/git/diff
GET /api/tasks/:taskId/git/files
GET /api/tasks/:taskId/git/file-diff

GET   /api/tasks/:taskId/findings
PATCH /api/findings/:findingId
POST  /api/tasks/:taskId/findings/select
POST  /api/tasks/:taskId/feedback/preview
```

统一错误响应必须包含稳定的 `code`、用户可读 `message` 和可选 `details`。并发冲突返回 `409`，输入错误返回 `400`，资源不存在返回 `404`，CLI 缺失或未登录返回 `422`，内部错误返回 `500`。

## 15. Web UI

总体布局包含项目列表、Task 状态与操作区、Codex、Git Diff、Claude Review、Activity 和 Feedback Editor。

按状态提供操作：

| Task 状态 | 主要操作 |
| --- | --- |
| draft | 开始 Codex 开发 |
| developing / fixing | 取消运行 |
| ready_for_review | 开始 Review、继续 Codex Session |
| reviewing | 取消 Review |
| waiting_for_human | 发送反馈、重新 Review、标记完成 |
| completed | 只读查看历史 |

Codex 面板显示 Prompt、最终回复、Plan、命令、退出码、文件变化、Usage、stderr 和运行状态；reasoning 与 raw event 默认折叠。

Claude 面板显示摘要、Verdict、严重级别统计、Findings、原始输出、解析失败提示和 Snapshot 过期状态。

Diff 面板使用 Monaco Diff Editor，支持文件状态、前后切换、Finding 行号标记和刷新。

## 16. 认证与安全

### 16.1 网络和路径

- 默认且仅支持 `127.0.0.1`；
- 不允许默认监听 `0.0.0.0`；
- 任务目录必须等于已注册 Project 的 canonical `rootPath`；
- 不提供公网访问或跨域任意来源访问。

### 16.2 命令执行

严禁 Shell 字符串拼接：

```ts
Bun.spawn([executable, ...args], { cwd, env });
```

不得调用 `sh -c`、`bash -c` 或把用户输入作为 Shell 代码。可执行文件覆盖设置必须是经过验证的绝对路径。

### 16.3 订阅认证优先

启动 Codex/Claude 子进程时，无条件从该子进程的环境副本中删除：

```text
OPENAI_API_KEY
CODEX_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
```

不得修改父进程或用户全局环境。应用继续继承 CLI 登录所需的 `PATH`、`HOME`、`SHELL`、Locale 和 CLI 配置位置。

该过滤只针对上述已知变量，用于避免显式 API 凭证优先于订阅认证，不保证识别所有第三方 Provider 的凭证注入方式。

### 16.4 日志

stderr、原始事件和诊断信息进入数据库前必须按 Key 名和常见 Token 格式脱敏。不得记录完整环境变量、认证文件内容或命令行中的 Schema/Prompt 之外的秘密。

## 17. 异常处理

- CLI 不存在：显示缺失的可执行文件和自定义绝对路径入口；
- CLI 未登录：保留脱敏后的原始错误，引导用户在终端完成登录；
- JSONL 单行失败：保存原始行、生成 `raw`/`stderr`、继续后续行；
- 子进程崩溃：保存退出码、stderr、最后事件和已获得的 Session ID；
- WebSocket 断线：浏览器用 `afterSequence` 补发；
- 数据库写失败：暂停读取广播、终止对应 Run，不能只展示而不持久化；
- 同项目写冲突：事务内拒绝第二个写 Run；
- Review 期间代码变化：标记过期，不丢弃结果；
- 服务关闭：停止新任务、终止活动进程树、标记 Run、关闭 WebSocket 和 SQLite。

## 18. 测试策略

### 18.1 单元测试

使用 `bun test` 覆盖：

- Codex/Claude Parser；
- Review Schema 与 Feedback Composer；
- Task 状态转换和异常回退；
- task-scoped event sequence；
- Snapshot Hash；
- canonical path 验证；
- CLI 参数数组和 CLI 可用性检测；
- 子进程环境过滤与日志脱敏；
- Diff 分类和 Finding 默认选择。

### 18.2 Fake CLI 集成测试

测试夹具提供假 `codex`、`claude`，模拟正常流、Session ID、慢输出、stderr、非法 JSON、未知事件、Schema 错误、非零退出、中途终止和取消。测试通过 PATH 或显式 executable path 使用 Fake CLI，不消耗订阅额度。

### 18.3 Git 集成测试

每个测试创建临时 Git 仓库，覆盖 tracked、staged、untracked、删除、二进制文件、脏基线和 Snapshot 过期。

### 18.4 Web E2E

使用 Playwright 覆盖：

```text
添加项目 → 创建任务 → Codex 开发 → Claude Review
→ 选择 Finding → 编辑反馈 → 发回 Codex → 再次 Review/完成
```

E2E 覆盖上述 happy path、页面刷新恢复和一条失败路径；其余状态转换和错误分支由单元测试覆盖。

### 18.5 Real CLI Smoke Test

提供显式命令，默认不在 CI 运行：

```bash
bun run smoke:codex
bun run smoke:claude
```

Smoke Test 必须在专用临时 Git 仓库中运行，并由开发者确认后执行，避免修改真实项目或意外消耗订阅额度。

## 19. MVP 验收标准

MVP 完成必须同时满足：

1. 无需配置 OpenAI 或 Anthropic API Key；
2. 可使用本机已安装并登录的两个 CLI；
3. 可注册至少三个 Git 项目，切换不影响后台状态；
4. Codex 输出实时显示且刷新后可补发；
5. Codex Session ID 在 Run 结束前即持久化；
6. tracked、staged、untracked Diff 均可查看；
7. Claude Review 在 CLI 权限层只读；
8. Review 可解析为 P0/P1/P2，解析失败时保留原始输出；
9. 用户可只选择部分 Finding、添加备注并编辑最终反馈；
10. 反馈只在用户主动操作后发送到精确 Codex Session；
11. Codex 可在相同 working directory 和 Session 中继续修改；
12. 可手动再次 Review 或标记完成，不存在自动无限循环；
13. 取消、失败和重启后 Task 均有明确恢复入口；
14. 项目、Task、Run、事件、Review 和反馈在重启后保留；
15. Review 期间代码变化会触发过期提示；
16. 服务只监听本机地址；
17. 用户输入不经过 Shell 字符串执行；
18. 同一项目不能同时运行两个写 Run；
19. `bun run typecheck`、`bun test`、Web E2E 和 `bun run build` 全部通过。

## 20. 后续扩展

MVP 稳定后可考虑：自动 Worktree、多 Task 并行、Electron 包装、ACP Driver、Gemini/OpenCode Driver、Review 规则模板、IDE 跳转和代码托管集成。这些扩展不能改变 MVP 的人工反馈门和本地优先默认值。

## 21. CLI 资料基线

本规格的 CLI 设计参考：

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)

资料基线仅用于实现参考；CLI 行为以运行时实际调用结果为准，优先于文档中的示例命令。
