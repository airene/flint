# Flint 整体 Code Review 报告(Agent B)

- 评审日期:2026-07-19
- 评审基线:`main` @ `251b3eb`(chore project refactor),工作区 clean
- 评审方式:全量通读 `apps/server`、`apps/web`、`packages/shared`、`tests`、`scripts` 与工程配置(约 7,700 行源码 + 4,700 行测试),并实际运行验证命令、比对真实 CLI 行为
- 验证环境:Bun 1.3.14 / TypeScript 7.0.2(tsgo)/ codex-cli 0.144.5 / Claude Code(均已本机安装并登录)/ macOS
- 更新(2026-07-19):原 2.1 / 2.2 / 2.3 与 3.4 中已修复的内容已从本文移除,其余章节编号保持原状(故存在空缺);修复后四门(typecheck / test / build / e2e)全绿,TypeScript 锁定 5.9.3

---

## 0. TL;DR

这是一个**架构质量远超"昨天才开始"水平**的项目:分层清晰(driver / service / ports / API 各司其职)、契约单一来源(shared zod schema 双端复用)、并发与崩溃恢复考虑周到、安全设计(loopback + Origin + Content-Type 校验、参数数组防注入、凭据环境变量剥离、脱敏)在同类本地工具里属于少见的认真。核心业务代码我没有发现 P0 级别的功能性 bug。

评审时发现的四项最高优先级问题(TS7 工具链导致 typecheck/build 失败、smoke.ts 传参错位、自动启动与 E2E/README 漂移、前端事件流 O(n²) 与无上限累积)已于 2026-07-19 全部修复,四个质量门重新全绿。本文剩余章节即为**仍待处理**的 backlog。

---

## 1. 验证结果快照(可复现)

| 命令 | 结果(2026-07-19 修复后) | 说明 |
| --- | --- | --- |
| `bun test` | ✅ 147 pass / 0 fail | 单元与集成测试质量高 |
| `bun run typecheck` | ✅ | shared 补 bun types;TypeScript 锁定 5.9.3;`scripts/**` 已纳入检查 |
| `bun run build` | ✅ | shared 显式 `rootDir`;TS 5.9.3 下 vue-tsc 恢复兼容 |
| `bun run test:e2e` | ✅ 8 passed | 用例已对齐 Create & start 自动启动语义 |
| `smoke:codex` / `smoke:claude` | 未执行(需授权) | 脚本传参已修复,待人工授权后运行 |

真实 CLI 参数核对(本机实测,均与代码假设一致,**这部分没有问题**):

- `claude --json-schema <schema>`、`claude auth status`(JSON 输出、exit 0)、`--permission-mode plan`、`--allowedTools <tools...>` 变参 —— 全部真实存在;
- `Bash(git status *)` 空格+星号语法与 `:*` 等价,是官方文档承认的前缀匹配写法(允许列表写法正确);
- `codex exec --json / --sandbox / --output-schema`、`codex exec resume`、`codex login status`、`-c sandbox_mode="..."` TOML 覆盖 —— 全部真实存在。

---

## 3. P2:值得尽快安排

### 3.1 `replaceFindings` 全量清空历史 findings,人工备注会永久丢失

`apps/server/src/api/database-ports.ts:200-206` 在每次新 review 解析成功时 `DELETE FROM review_findings WHERE task_id = ?`,把**之前所有 review run 的 findings 连同用户的 selected/dismissed/userNote 一起删掉**。schema 本身是按 `runId` 组织的,完全支持保留;前端 `review-display.ts` 也已经为老 run 做了从 `structuredOutput` 兜底还原的逻辑(但备注还原不了)。建议改为只追加、按 runId 查询,顺带解锁"对比两轮 review"的产品能力(见 5.A)。

### 3.2 `/git/status` 每次都做全量 capture,大仓库会痛

`apps/server/src/api/application.ts:404-406` 的 status 路由调用 `git.capture()`:两次 status 扫描是小事,但它会**逐个读取全部 untracked 文件内容进内存**(`git.service.ts:84-119`,无大小上限)、跑 3 个 diff、算 snapshot hash。前端在每个 run 终态事件后 80ms 就会 refresh 一次(`task-workspace.ts:82-85`),载入任务页也必调。对含有大 untracked 产物(构建输出、模型文件、日志)的仓库,这是内存和延迟双重风险。

建议:a) status 路由降级为轻量 scan(不读文件内容),只有 review/feedback 前才做完整 capture;b) `readUntrackedContent` 加单文件大小上限(超限按 binary 处理只记 hash);c) 可按 mtime/size 做 snapshot 缓存。

### 3.3 SQLite 没开 WAL / busy_timeout,事件写入是逐条事务

`apps/server/src/db/database.ts:93-99` 只设了 `foreign_keys`。影响:a) 每条 agent 事件一个 immediate 事务(`database-ports.ts:152-170`),默认 journal 模式下每条都 fsync,codex/claude 高频输出时事件落库会成为吞吐瓶颈(现在事件发布在解析循环里是 await 的,会反压 stdout 读取);b) README 鼓励用 `LOCAL_PAIR_REVIEW_DATABASE` 跑多实例,两个进程碰同一文件时没有 busy_timeout 会直接 `SQLITE_BUSY`。建议启动时 `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`。

### 3.4 事件历史仍从 sequence 0 全量重放,缺分页与虚拟滚动

- 每次进入任务页 `controller.start(taskId, 0)` 仍从 sequence 0 重放全部历史事件,长任务首次加载会传输完整历史;
- ActivityPanel 对可见事件全量 reverse+map,无虚拟滚动。

建议:初始加载只取最近 N 条 + "load older"(服务端 replay 已支持 afterSequence,补一个 REST 分页端点即可);事件列表加虚拟滚动。

### 3.5 本地 API 无任何鉴权 token

`apps/server/src/api/security.ts` 的 loopback + Origin + `body()` 强制 `application/json`(挡掉了表单类 CSRF)组合对**浏览器**攻击面防得不错,这点值得表扬。但任意本地进程(如某个恶意 npm postinstall)都能直接 POST `/api/tasks/:id/develop`,以你的订阅身份驱动一个**可写**的 developer CLI 去改已注册仓库。虽然"本地进程本来就能干坏事",但 Flint 把"已登录的 agent CLI + 已注册仓库清单"打包成了一个免认证的 HTTP 面。建议:启动时生成随机 token,注入前端(dev 模式经 Vite env,prod 模式随 index.html 下发),API/WS 校验之;成本低,纵深收益明显。

### 3.6 写而不读的字段/死代码(半成品特性的痕迹)

| 位置 | 问题 |
| --- | --- |
| `db/schema.ts:8-9` + `project.service.ts:51` | `projects.defaultDeveloper/defaultReviewer` 建了列、写死默认值,但建任务时读的是全局设置(`task.service.ts:75`),列从未被读 → "按项目配置角色"半途而废 |
| `database-ports.ts:114` | `task.reviewerSessionId` 持久化了但全项目零读取(review 永远新开 session) |
| `shared/index.ts` + `ProjectsView.vue:37` | `Project.lastOpenedAt` 有 schema、有 PATCH API,但前端从未更新它,列表永远显示 "Not opened yet" |
| `task-workspace.ts:57` | `latestReviewRun` computed 无消费者 |
| `shared/index.ts:160-161` | 事件类型 `usage`、`stderr` 定义了但服务端从不发出(stderr 仅失败时进 errorMessage,`streaming-cli.driver.ts:114-118`) |
| `api/endpoints.ts` | `updateTask`/`getGitDiff`/`getGitFiles`/`getRun`/`health` 等端点 UI 未使用;其中 `updateTask` 意味着**任务标题/prompt 创建后没有任何编辑入口**,而服务端和契约都支持 |

这些不是 bug,但每一个都在增加"读代码的人以为有这功能"的成本。建议要么接线(多数只差几行 UI,见 5.A),要么删。

### 3.7 状态机与展示的两个边角

- reviewer run 失败/取消时 `reviewParseStatus` 永远停在 `"pending"`(`agent-run.service.ts:198` 原样保留),`ReviewPanel.vue:62` 的 else 分支会对一个 **failed** 的 review run 显示 "Review in progress",文案误导;
- 从 `waiting_for_human` 发起 re-review,一旦失败/取消,`taskStatusForRunFailure` 统一回落 `ready_for_review`(`task-run-state.ts:42`),FeedbackEditor 随之消失——上一轮明明已有可发送的 findings,用户被迫再跑一次 review 才能回到可发送状态。可考虑失败时回落到发起前的状态。

### 3.8 工程化缺口

- **没有 CI**(无 `.github/workflows`):评审时那批"质量门腐烂"问题(已修复)的根本解药是一条跑 `typecheck + bun test + build (+ e2e)` 的 CI;
- **没有 lint/format 配置**(eslint/biome/prettier 均无):多 agent 协作开发尤其需要机器裁判;
- `bun run typecheck` 对 web 实际上**只检查 .ts**(tsc 不吃 .vue),`.vue` 模板类型检查只在 `build` 里由 vue-tsc 执行——typecheck 绿灯的含金量比看上去低,建议 typecheck 脚本对 web 改用 `vue-tsc --noEmit`;
- zod 版本漂移:shared `^4.1.12` vs server `^4.4.3`,建议对齐到同一 caret;
- `tests/**` 仍无类型检查(`scripts/**` 已于 2026-07-19 纳入):首次尝试纳入时暴露约 20 处测试文件类型债(fetch double 缺 `preconnect`、可选字段未加断言、workspace 包解析配置),建议清偿后并入 typecheck;
- TypeScript 已锁定 5.9.3:vue-tsc 尚不支持 TS7 原生编译器,跟踪 vuejs/language-tools#5381,上游支持后一行 bump 回 7;
- `.idea/` 部分文件已入库(`flint.iml`、`modules.xml` 等),按团队习惯决定是否移出。

---

## 4. P3:记录在案的小问题

1. `utils/path.ts:33` `validateRepositoryRelativePath` 不拦 Windows 形态(`C:\...`、反斜杠 `..\`);当前调用点因先经 git status 文件名匹配而实际可达性低,属纵深防御补强。
2. `utils/process-supervisor.ts:89-96` `cancel()` 固定 `sleep(graceMs)`(默认 1s)再判断,即使进程瞬间退出,取消请求也至少挂 1 秒;同文件的 `stopProcessTree` 已有轮询式等待,可复用。
3. `application.ts:143-153` CLI 可用性缓存永不过期(只有设置变更才失效);CLI 中途登出后 `requireCli` 仍放行,直到用户手动 recheck。可加 TTL 或在 run 启动失败时刷新。
4. `application.ts:70-76` `body()` 抛的 SyntaxError 带有具体原因(如 "Write requests require application/json."),但 `errors.ts:60` 统一替换成 "Invalid request.",调试体验受损。
5. `database-ports.ts:315` `recoverInterrupted` 全表加载 agent_runs 再 JS 过滤,应下推 WHERE。
6. Claude developer 以 `acceptEdits` 无头运行时,Bash 默认被拒(README 有说明),但 UI 不会提示"agent 因权限无法跑命令"——任务要求跑测试时用户只会看到奇怪的结果。可在 activity 里高亮 permission-denied 类事件。
7. `event-hub.ts:65-78` `send()` 缩进异常(8 空格),纯格式。
8. shutdown 时 `recoverInterrupted(activeIds)` 会把已经终态 `cancelled` 的 run 改写为 `interrupted` 并覆盖 finishedAt(`application.ts:502` + `database-ports.ts:318`),边角一致性问题。
9. `apps/web` 全量引入 monaco(编辑器 + worker),产物体积大;本地工具可接受,若在意可换 diff-only 轻量方案或按需加载。
10. Reviewer prompt、continue 默认语 `"继续处理当前任务，并总结本轮变更。"`(`application.ts:342`)、feedback 模板(`feedback.service.ts:78-95`)均硬编码中文,而 UI 全英文——英文用户会得到中文 findings。建议 prompt 语言可配置或跟随任务语言(见 5.B)。

---

## 5. 功能增强建议

### 5.A 顺水推舟(数据/契约已就绪,只差接线)

1. **按项目配置 Developer/Reviewer**:列已存在(3.6),创建任务时 `project.defaultX ?? 全局设置` 即可。
2. **Reviewer 追问**:`reviewerSessionId` 已持久化,加一个 "Ask reviewer" 输入框 resume reviewer session(read-only 约束不变),让用户对某条 finding 要求澄清/举证——这比直接把 finding 发给 developer 更贴近真实结对。
3. **任务编辑**:`updateTask` API 已存在,补 UI 即可(至少允许改 title)。
4. **Token 用量统计**:codex `turn.completed` 事件里已有 usage(ActivityPanel 已经在展示单条),聚合到 run/task 维度显示成本感知。
5. **最近打开排序**:接线 `lastOpenedAt`(进入 ProjectView 时 PATCH 一下),Projects 列表按最近使用排。
6. **多轮 review 对比**:在 3.1 改为按 run 保留 findings 之后,Run History 选中不同 reviewer run 即可对比两轮结果,并显示"上轮 N 条已修复"。

### 5.B 产品向(中期)

1. **桌面通知**:run 结束/review 出结果时 Web Notification——长任务期间用户必然切走,这是这类工具留存率最高的小功能。
2. **人工 Finding**:允许用户在 DiffPanel 选中行手动添加 finding(severity/描述),与 reviewer findings 一起进 feedback 组稿。目前"人工只能改文本",让人工发现的问题结构化留档更符合"pair review"定位。
3. **任务级 worktree 并行**(spec 明确列为非目标,但它是最自然的 v2):当前一个项目同时只能有一个写 run,`.worktrees/` 目录名暗示你已经用 worktree 开发过 Flint 自己——把它产品化,每个任务一个 worktree,互不阻塞。
4. **可选的自动 review**:开发完成自动触发 reviewer(feedback 仍然人工 gate),一个开关即可,不违背"finding 永不自动发送"的底线。
5. **Prompt 模板配置**:review prompt 与 feedback 模板允许用户级覆盖(存 app_settings),顺带解决语言硬编码问题(4.10)。
6. **导出 patch / 复制 diff**:`gitDiffResponse` 已含 tracked/staged/untracked 三段 patch,加个下载按钮就能把任务成果带走(MVP 不做 commit,这是不越界的替代出口)。
7. **新 Provider**:driver 抽象(`AgentDriver` + `ProviderRegistry` + parser)是这个代码库最漂亮的部分之一,新增 Gemini CLI / OpenCode 只需 driver+parser+availability 三件套;建议真到那一步时把 `Provider` 枚举从 shared 契约里解耦成注册表驱动,否则每加一家要动全链路类型。
8. **事件搜索/过滤增强**:长 run 的 Activity 面板加文本过滤和按事件类型筛选,配合 3.4 的虚拟滚动。

### 5.C 明确不建议现在做

自动 developer↔reviewer 循环、commit/push/PR 集成、远程访问——spec 的排除理由(人工 gate 是产品的灵魂、安全边界清晰)依然成立,上面 5.B 的增强都刻意保持在这条线内。

---

## 6. 做得好的地方(保持)

1. **契约单一来源**:shared 包 zod schema + `.strict()`,前端对每个响应做 `safeParse`(`api/client.ts:136`),接口漂移在开发期就会炸出来。
2. **并发与幂等设计**:queue 事务内检查 + DB partial unique index 双保险(`schema.ts:53-58`)、feedback 的 lease + 内容去重(`database-ports.ts:213-229`)、任务状态机集中在 `task-run-state.ts` 且事务内断言。
3. **崩溃恢复**:启动 `recoverInterrupted` + shutdown 依次 interrupt/settle/标记/广播(`application.ts:495-512`),run 不会卡在 running。
4. **事件重放协议**:服务端按 task 单调 sequence + 客户端 cursor/pending 缓冲乱序重组 + 断线指数退避续传(`realtime/task-events.ts`),这套实现比很多生产系统都规整。
5. **snapshot hash**:长度框定(length-framing)+ 路径排序 + untracked 内容纳入(`git.service.ts:75-82`),不会被拼接歧义骗过。
6. **进程安全**:参数数组、显式 cwd、`detached` + 进程组终止、凭据环境变量剥离、stderr 只在失败时暴露、诊断脱敏(`utils/redact.ts` 对 tokens 复数形态的豁免处理很细)。
7. **降级路径**:review 结构化解析失败保留原始输出并可视化提示;untracked/binary/symlink/rename 在 git 层都有处理;fake CLI fixture 覆盖了泄漏子进程、探测挂起这类阴间场景,测试用心。
8. **UI 状态防串台**:generation/token 模式贯穿 store(`workspace-refresh-guard.ts`),快速切换任务不会把旧响应写进新视图。

---

## 7. 建议的处理顺序

1. 加最小 CI(typecheck + test + build,e2e 可选)防止质量门再次腐烂;
2. 人工授权后真正跑一次 `smoke:codex` / `smoke:claude`(脚本已修复),完成 DoD 的最后一项;
3. 按 3.x 顺序消化(建议先 3.1 findings 保留与 3.3 WAL,改动小收益大);
4. 功能层面从 5.A 挑:桌面通知(5.B.1)+ reviewer 追问(5.A.2)+ 用量统计(5.A.4)是我认为性价比最高的三个。

---

*本报告由 Agent B 独立完成;除本文件外未改动任何代码。所有失败结论均来自实际命令执行,所有 CLI 行为结论均经本机真实 CLI 或官方文档核实。*
