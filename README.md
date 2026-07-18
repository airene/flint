# Flint — 本地结对评审

Flint 是一个完全在本地运行的工作流，让你可以在现有 Git 仓库中协调可配置的 Developer CLI 与只读 Reviewer CLI。默认组合是 Codex Developer 与 Claude Reviewer；也可以在 **CLI 设置**中将 Codex 或 Claude 分配给任一角色。Flint 保留了人工 review 和 feedback gate：Finding 永远不会自动发送，feedback 也只会恢复任务已持久化的精确 Developer session。

## 安装与 CLI 前置条件

Flint 需要 Bun 1.3 或更高版本、Git，以及至少一个受支持且已登录的 Agent CLI。当前支持 Codex CLI 与 Claude Code，两者都可以担任 Developer 或 Reviewer；如需自由组合角色，请同时安装并登录两个 CLI。当前 checkout 已验证 Bun `1.3.14` 和 Git `2.50.1 (Apple Git-155)`。Codex 与 Claude 的版本会在运行时自动检测，并显示在 **CLI 设置**中；本 README 不假定用户安装了某个特定版本。

```bash
bun install
codex login
claude auth login
```

请为计划使用的 CLI 完成正常订阅登录。Flint 不需要 OpenAI 或 Anthropic API key，并会在启动子进程前移除常见的 API 凭据环境变量。

## 运行、测试与构建

一条命令同时启动 API server 和 Vite UI：

```bash
bun run dev
```

API 仅监听 `127.0.0.1:3000`；开发期间，Vite 会将 `/api` 和 `/ws` 代理到该地址。

如需以单进程方式运行 production build，先完成构建，再启动打包后的 Bun server。Vue SPA、API 和 WebSocket 会通过同一个 loopback origin 提供服务：

```bash
bun run build
bun apps/server/dist/index.js
```

```bash
bun test
bun run test:e2e
bun run typecheck
bun run build
```

`bun run test:e2e` 会使用 Fake Codex 和 Claude fixture 启动相互隔离的 Bun server 与 Vite 实例。测试会创建一次性的 Git 仓库，不会访问任何订阅服务。

当前 checkout 的验证状态：自动 typecheck、Bun tests、Fake CLI browser E2E 和 production build 均已通过。已验证 Bun `1.3.14` 和 Git `2.50.1 (Apple Git-155)`。真实 Codex 和 Claude smoke test **尚未执行**，因为它们需要用户明确授权；CLI 版本及真实测试结果将在获得授权后确认。

## 配置与本地数据

默认情况下，Flint 将 SQLite 数据保存在 `~/.local-pair-review/data/app.db`。如需运行独立的本地实例，可以覆盖该路径：

```bash
LOCAL_PAIR_REVIEW_DATABASE=/absolute/path/to/data.sqlite bun run dev
```

CLI executable 的覆盖值必须使用绝对路径：

```bash
CODEX_EXECUTABLE=/absolute/path/to/codex
CLAUDE_EXECUTABLE=/absolute/path/to/claude
GIT_EXECUTABLE=/absolute/path/to/git
```

这些路径也可以在 **CLI 设置**中保存并重新检查。通过 UI 设置的路径会经过绝对路径校验，并持久化到本地 `app_settings` 表中；清空字段即可恢复启动时的默认值。打包时可以使用 `LOCAL_PAIR_REVIEW_WEB_ROOT` 覆盖构建后的 `apps/web/dist` 目录。

### 任务角色

**CLI 设置**提供 `Developer CLI` 与 `Reviewer CLI` 两个全局默认值。当前 Codex 和 Claude 都支持两个角色，默认组合为 Codex Developer / Claude Reviewer，也允许同一个 provider 同时担任两个角色。

角色设置只影响之后创建的新任务。任务创建时会固化当时的 Developer 与 Reviewer provider；之后修改全局设置不会改变已有任务使用的 provider 或精确 session。

## 安全与权限

Flint 的设计目标就是仅在本地运行。Server 只绑定 loopback 地址并拒绝非本地浏览器请求；启动子进程时使用参数数组和明确的 working directory，绝不会调用 shell command string，也不会修改当前进程的 working directory。

Developer 在已注册的项目目录中以允许修改工作区的权限运行：Codex 使用 `workspace-write` sandbox，Claude 使用 `acceptEdits` 和用户自己的权限配置，Flint 不会为 Claude 启用 `bypassPermissions`。

Reviewer 始终受只读约束：Codex 使用 `read-only` sandbox 与结构化 review schema；Claude 使用 `plan` permission mode、范围严格的只读 tool allowlist 和 review JSON schema。Reviewer 的 edit/write、破坏性 Git 操作、commit 和 push 会在 CLI 层被禁止。子进程环境中的 API 凭据会被移除，诊断输出也会在存储或展示前完成脱敏。

## 工作流程

1. 注册本地 Git 仓库的绝对路径。
2. 以当前 `HEAD` 为 baseline，创建一个范围明确的 Task。
3. 启动任务固化的 Developer CLI；Flint 会在 CLI 输出 session ID 后立即精确持久化。
4. 开发准备完成后，启动任务固化的只读 Reviewer CLI。
5. 选择或忽略 Finding、添加人工备注、生成 feedback preview，并在需要时进行编辑。
6. 明确发送编辑后的 feedback，恢复对应的精确 Developer session。
7. 根据需要再次发起 review，或手动将 Task 标记为完成。

## MVP 限制

Flint 不提供自动 Developer/Reviewer 循环、用户系统、远程访问、worktree、commit、Pull Request 或 push。除非通过你明确启动的 Developer CLI，否则 Flint 不会修改仓库。发送 feedback 前如果检测到 stale review snapshot，系统会要求人工确认。被中断或失败的 Run 会继续保留，并提供手动恢复入口；后台不会静默重试或消耗订阅额度。

## 真实 CLI smoke test

以下命令有意排除在常规测试和 CI 之外：

```bash
bun run smoke:codex
bun run smoke:claude
```

每条命令都会创建一个专用的临时 Git 仓库，输出解析后的 executable 路径、检测到的版本、authentication mode 和仓库路径，然后等待你输入精确确认文本 `RUN`。在收到确认前，不会执行任何真实订阅命令。

Codex smoke test 要求生成可见的 Diff，并且只有在初始 Run 返回 session ID 后才会使用精确 ID 执行 resume。Claude smoke test 会验证 structured result 和精确 session ID，同时证明仓库 snapshot 在只读权限下没有发生变化。两项测试都只会删除各自创建的临时仓库。
