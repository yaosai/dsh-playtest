# Playtest v1.1 实现边界与组件契约

本插件不是 agent/harness：不调用 LLM，不管理模型会话，不提供通用计划审批。skill 引导现有 agent；工具和 UI 共用测试操作；Python 引擎无 DSH 也能运行。

## 资产
- `<repo>/.test-plays/<slug>/play.json`：version=1，scenarioName，description，mode=explore|baseline|acceptance，claims（id/description/basis，可选），steps。
- 同目录 `scenario.json`（可选，或指定同目录下其他场景文件）：variables、setup 步骤、cleanup 步骤、mocks；play 也可包含 cleanup。
- `<repo>/.test-plays/config.json`（可选）：targets {name:{baseUrl,description}}、databases {name:{driver:'sqlite',path:'相对仓库路径'}}。不默认某个项目的接口名、端口、框架健康路径或某个旧 skill。
- 运行资产 `<repo>/.test-plays/runs/<runId>/`：snapshot.json、events.jsonl、result.json。剧本本身不回写。

## 阶段

一次播放固定：`prepare`（项目声明的只读就绪检查）→ `setup`（场景数据准备）→ `play`（业务步骤）→ `cleanup`（收尾）。

- `prepare` 来自 `.test-plays/config.json` 顶层，不是剧本字段；插件不解释“就绪”的业务含义，只执行项目声明的检查。
- 只允许 `http`（GET/HEAD/OPTIONS、无 body）、`dbQuery`、`dbWait`，且必须有非空 `expect`；DB 检查必须只读。每个剧本执行前跑一次自己的 prepare。
- prepare 失败：该 play `execution:"blocked"`、`verdict:"inconclusive"`、`cleanup:"skipped"`（未改动任何东西），进程退出码 2；setup/play 不再执行。prepare 的断言不计入业务 verdict。
- prepare 的真实调用/适配器读取照常进入 `effects`，`play` 字段为该剧本名（因为它按剧本执行）。

## 步骤
- http（默认）：method/path/body/headers，expect {status, json:{'$.path':value}}，extractFromResponse {var:'$.path'}。
- dbQuery/dbWait：database（默认 main）、sql、params（可选）、expect（首行列值）、extract（变量到列），dbWait timeoutSeconds/intervalSeconds。
- wait：seconds。
- mockVerify：mock（id）、path/method（可选）、count（精确次数）。
- scenario.mocks [{id,port:0,routes:[{method,path,status,body}]}]：绑定 127.0.0.1，GET/POST 等按 method/path 匹配，请求日志和 verify 支持。
- 变量：`${runId}`、`${runDir}`、`${mock.<id>.url}`、自定义变量、响应提取变量；整值替换保留 JSON 类型；缺失变量失败，不使用 eval。
- 无断言的动作可执行但只算 observed，不冒充验收通过；HTTP 状态码显式检查，网络错误不能成为预期业务拒绝。
- 首版拒绝旧 expectFailure 的模糊语义并提供迁移提示；有明确 expect.status/json 才验证失败分支。
- `dbWait` 允许只有 `extract` 没有 `expect`：等待条件就是“行出现并取到列”；两者都没有时报 `db_wait_expect`。
- mock route 的 `method` 可为 `"*"`：应答任意方法（迁移旧桩时用，旧桩 GET/POST 都答）。
- `preview.assertions` 只统计业务步骤；`preview.prepareAssertions` 单独给出场景准备的断言数。场景准备永不掩盖“业务步骤无断言”的警告。
- `checks`（可选，每步最多 32 项）：内嵌校验，随所属步骤执行，不产生独立步骤。只能使用 dbQuery/dbWait/mockVerify；不得嵌套；动作类型会被拒绝。
  - 步骤状态：动作断言与全部 checks 通过 => passed；任一断言不匹配 => failed 并停止后续步骤。
  - check 自身抛错（适配器/网络/变量）=> 该 check 记 `status:"error"` + `errorCode`，步骤 failed，且与断言不匹配区分。
  - step.checks[] 记录 {index,name,type,status,assertionCount,durationMs,error?,errorCode?,evidence?}；step.assertionCount 含 checks 的断言。
  - check 可 `extract` 变量供后续步骤使用；断言仍归属父 step 的 stepId。

## 交给 agent（视图 → 新会话）

「创建」在骨架写完后调用同一对被 GUI 使用的 Remote 能力,不新增注入依赖(来自已注入的 `@deepseek-ai/dsh-api-remotes`):

- `session.create({ cwd })` → `{ sessionId }`（响应可能包在 `RemoteResult` 里,两种形状都要接）
- `session.prompt({ requestId, sessionId, mode: "queue", content: [{type:"text", text}] }, signal)` → `{ accepted: true }`

**参数个数按对方面函数的声明取,不要照 Host 签名硬写。** 生成面里 `create` 只收 1 个参数、`prompt` 收 2 个;照 `(request, signal)` 统一调用会被网关拒:
`client api: session/create expected 1 argument(s), got 2`。视图读 `face[method].length` 决定传几个,并在遇到该 arity 报错时按报错里要求的个数**纠正重试一次**（只一次,不循环）——签名差异因此不会变成坏按钮,也不会掩盖真正的失败。

`requestId` 由客户端生成并持久化在正好一条被接受的用户消息上,重复提交因此幂等。骨架已经落盘:交接失败只报告,不回滚、不假装没建。宿主缺该命名空间时,视图退化为提示用户自己对 agent 说一声。

## 失败交接（运行 → agent）

界面在运行结论非 passed 时提供交接，`session.prompt` 的正文必须携带：`runId`、剧本名、`verdict/execution/cleanup` 三元组、`artifacts.runDir`、未通过步骤（阶段、步号、名称、状态、断言消息）。措辞由界面 locale 提供，插件不解释失败原因本身——归因是 agent 的工作，且必须限定在「剧本错 / 环境夹具不满足 / 真实业务缺陷」三类之一，禁止以放宽断言换取通过。

## target 级 headers（1.13.2）

`targets.<name>.headers` 是对象，值为标量；编译时合并进每个 HTTP 步骤的 `headers`（步骤同名键覆盖）。合并的前置条件：该步不是指向自己 mock 的 `${mock.x.url}`，且**实际请求 URL** 的 `scheme://host:port` 与 target `baseUrl` 一致——凭据不跨源。保留头 `host` / `content-length` / `connection` / `transfer-encoding` / `expect` 与非标量值都在 lint/preview 阶段报 `invalid_target_header`。

## 目录（catalog）给选择器的字段

`catalog` 每个剧本除 `slug/name/description/mode/steps/scenarios` 外还带 `defaultScenario`（取 `play.json` 的 `scenario` 字段，缺省 `scenario.json`）；顶层带 `targets`（`.test-plays/config.json` 中 `targets` 的键名，已排序）。这些只服务界面下拉框，不参与摘要计算。

## 效果（effects）

预览不连接任何东西，只列出将要发生的真实动作。每条效果带稳定机器码 `code`，界面按它本地化：

- `http.external`：调用非本插件启动的服务（含 target/baseUrl 解析后的目标）
- `database.command`：调用项目侧 command 适配器（含只读查询）
- `database.write`：写入 SQLite 或影响不可判定的 SQL

`description` 保持英文供 agent/CLI 阅读；`requiresConfirmation` 决定是否必须人来点播放。

## 资产写入（create / draft）

两者都拒绝覆盖已存在的剧本目录，且必须通过 Host 的文件写权限检查（read-only 会话与越出工作区的仓库都会被挡下）。

- `create {title,name?,target?,description?}` →（`name` 省略时由标题推导 kebab 目录名:英文/数字词优先,纯中文落 `play-<sha256前缀>`;冲突则加长哈希。仓库只有一个 target 时自动采用,多个则不猜） `.test-plays/<name>/{play.json,scenario.json,NOTES.md}`；play 为 `mode: explore`、`steps: []`。不猜接口、不生成断言。
- `draft {runId,name?,play?,title?}` →（`name` 省略时为 `<所播剧本>-observed`,占用则加 runId 哈希后缀；`title` 省略时沿用原标题并加“（沉淀）”） 读取 `.test-plays/runs/<runId>/snapshot.json`（步骤证据优先取 `result.json`，缺失时回退 `events.jsonl`）复制该剧本与场景，再按规则补断言：
  - 只填原步骤**没有**的字段；已有 expect 一律保留。
  - 状态失败 / 该步在这轮失败 / 证据 `truncated` / 值含 `[REDACTED]` / HTTP ≥400 → 不写成预期，只记入 NOTES.md。
  - HTTP 取顶层标量、DB 取首行标量，各上限 8 个字段。
  - 产物始终 `mode: explore`，`source.kind = "draft"` 并记 `runId`/`runDigest`。

`engine/cli.py：一个 stdin JSON 请求`
`{action,repoRoot,play?,plays?,scenario?,target?,expectedDigest?,runId?,allowEffects?,skipCleanup?,name?,title?,description?}`
- catalog：返回 `{ok,repoRoot,plays:[{slug,name,description,mode,steps,scenarios}]}`。
- inspect：返回 `{ok,digest,requiresConfirmation,effects,issues,preview,snapshot}`。snapshot 必须完整覆盖执行所需资产（配置、剧本、场景、引用内容），预览不执行请求/造数。
- lint：返回 `{ok,errors,warnings,issues}`，检查已选或全部 play；未知选择/空目录不能假绿。
- scaffold：name 为 slug，创建安全、可直接播的本地 HTTP mock 示例，不猜真实系统接口。
- run：用 play 或 plays（批量），重新核对 expectedDigest；NDJSON 实时输出 `{seq,type,runId,...}`；终态 `{type:'run_finished',result:{ok,runId,status,verdict,execution,cleanup,steps,assertions,subRuns?,artifacts,...}}`。
- 非 run stdout 只输出一个 JSON；错误同样有 `{ok:false,error}`。退出 0=可正常完成且断言未失败、1=断言/执行失败、2=配置/环境问题、130=取消。
- setup/主步骤/cleanup 和 mock 关闭都有事件；异常、失败、SIGTERM 仍尝试清理；取消不可让下一正常步骤执行，但 cleanup 有独立有限时间。
- 仅允许显式 target/baseUrl 与自身 mock 的 HTTP origin，禁重定向越界；绝不因为域名含 test 就当安全。
- 非自身 mock 的 HTTP 与非运行目录内的数据库写入要求 effects 确认；CLI 的 allowEffects 只是引擎开关，DSH wrapper 必须从用户点击或 approval 服务获得，不暴露 agent 可自授权参数。
- SQLite 路径、资产引用、运行目录必须 canonical 在仓库内；拒绝路径穿越/越界 symlink。只读访问不创建库。
- 请求/响应证据有界且脱敏，记录截断，断言对完整受限读取内容比较；凭据不落入可展示快照。

## Host/UI
- 原生 conversation.view 插槽，id=playtest，label 为本地化的业务测试。
- 通过 session command `/playtest <JSON>` 执行 UI 操作。Client 使用当前 sessionId。command 返回 success.text = JSON 字符串，错误保留。
- 共用操作：catalog、inspect、lint、scaffold、start（单个/批量）、runs、read、cancel。
- start 成功立即返回 runId，UI/agent read 有界读取状态、步骤、证据；不另起 HTTP 服务器。
- wrapper 获取 agent 的 fs/subprocess/sandboxPolicy/sandbox/workingDirectory 服务；进程经 sandbox.confine；运行写入遵守当前会话权限，不自动提升。
- UI 确认属于用户动作；agent start 工具遇到真实效果用 DSH approval.request。没有审批设施则不执行。
- 运行由发起 session 所有，其他 session 不能读或取消；重启可在当前仓库读取历史运行，未完成历史标 interrupted/cleanup unknown，不自动重放。
