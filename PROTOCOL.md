# Playtest v1.1 实现边界与组件契约

本插件不是 agent/harness：不调用 LLM，不管理模型会话，不提供通用计划审批。skill 引导现有 agent；工具和 UI 共用测试操作；Python 引擎无 DSH 也能运行。

## 资产
- `<repo>/test-plays/<slug>/play.json`：version=1，scenarioName，description，mode=explore|baseline|acceptance，claims（id/description/basis，可选），steps。
- 同目录 `scenario.json`（可选，或指定同目录下其他场景文件）：variables、setup 步骤、cleanup 步骤、mocks；play 也可包含 cleanup。
- `<repo>/.playtest.json`（可选）：targets {name:{baseUrl,description}}、databases {name:{driver:'sqlite',path:'相对仓库路径'}}。不默认 SAP、8080、Spring health、任何旧 skill。
- 运行资产 `<repo>/.playtest/runs/<runId>/`：snapshot.json、events.jsonl、result.json。剧本本身不回写。

## 步骤
- http（默认）：method/path/body/headers，expect {status, json:{'$.path':value}}，extractFromResponse {var:'$.path'}。
- dbQuery/dbWait：database（默认 main）、sql、params（可选）、expect（首行列值）、extract（变量到列），dbWait timeoutSeconds/intervalSeconds。
- wait：seconds。
- mockVerify：mock（id）、path/method（可选）、count（精确次数）。
- scenario.mocks [{id,port:0,routes:[{method,path,status,body}]}]：绑定 127.0.0.1，GET/POST 等按 method/path 匹配，请求日志和 verify 支持。
- 变量：`${runId}`、`${runDir}`、`${mock.<id>.url}`、自定义变量、响应提取变量；整值替换保留 JSON 类型；缺失变量失败，不使用 eval。
- 无断言的动作可执行但只算 observed，不冒充验收通过；HTTP 状态码显式检查，网络错误不能成为预期业务拒绝。
- 首版拒绝旧 expectFailure 的模糊语义并提供迁移提示；有明确 expect.status/json 才验证失败分支。

## engine/cli.py：一个 stdin JSON 请求
`{action,repoRoot,play?,plays?,scenario?,target?,expectedDigest?,runId?,allowEffects?,skipCleanup?}`
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
