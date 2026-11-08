# Playtest：业务测试播放器与观测插件

Playtest 把“剧本（动作与断言）＋场景（环境数据与依赖）＋播放（运行与观测）”接入 DSH。它不是另一个 agent：没有模型调用、没有自主任务循环、没有通用计划审批平台。

已有 coding agent 用方法论调查系统、提出有依据的测试；插件负责可执行校验、步骤播放、mock、确定性断言与证据。没有 LLM 时，Python 引擎也可以独立运行。

## v1.1 能做什么

- 独立的剧本与场景：同一流程切换输入、setup、cleanup 和 HTTP mock。
- HTTP 状态/JSON 字段断言、SQLite 查询与条件等待、精确 mock 调用次数验证。
- 显式区分观测、断言通过、断言失败、执行错误与清理情况。
- 保存每次运行的输入快照、NDJSON 事件与结果；不把 lastResponse 写回剧本。
- DSH 原生“业务测试”Conversation View：剧本列表、执行预览、步骤时间线、预期/实际和取消。
- 复用 DSH 的文件权限、进程沙箱、管理进程与必要的用户授权，不自动启动被测服务。

### 不做什么

不从代码自动证明业务规则正确；不把 HTTP 200 当作业务成功；不把网络故障当作预期业务拒绝；不提供生产数据修复。首版没有 Kafka/RabbitMQ 驱动、其他数据库驱动、设备数字孪生、Excel 上传下载断言。它们需要后续适配，不能用“可扩展”当成已支持。

## 使用方法

### 在 DSH 中

安装 bundle 后，在当前会话的 View 选择中选择 **业务测试 / Playtest**（与 Chat、Trajectory 并列）。不需要另开服务器或 iframe。

1. 仓库字段为空时使用当前会话目录；可以改为另一个允许访问的项目目录。
2. 选择剧本与场景，先查看预览：步骤、断言数、目标、mocks、效果与警告。
3. 点击播放。自身 HTTP mock 示例不触碰外部系统；真实目标调用或非运行目录内的数据库写入需要用户确认。
4. 看断言、执行、清理三个结果，以及每步的证据。取消后也应查看最终清理情况。

工具与 UI 使用同一组 Host 操作：

| 工具 | 用途 |
|---|---|
| `playtest` | `catalog` 列出；`inspect` 预览；`runs` 历史；`read` 读步骤/事件；`cancel` 停止 |
| `playtest_run_play` | 启动单个剧本，立即返回 runId；不是返回“已通过” |
| `playtest_run_suite` | 顺序运行选定或全部剧本，返回统一 runId |
| `playtest_lint` | 检查结构，不执行业务动作 |
| `playtest_new_play` | 创建可直接播放的本地 mock 示例，再按当前业务替换 |

`read` 用 `after` 游标，返回 `nextOffset` 和截断提示；结果/步骤快照不依赖事件是否被分页。活跃运行由发起会话所有，同一仓库不并发造数。历史记录也检查 ownerSessionId，不跨会话暴露；独立 CLI 记录可直接从项目查看。

### 无 DSH 的独立 CLI

从插件目录运行下面命令。整个示例仅启动自身 loopback mock；运行文件写在示例项目内。

```bash
python3 engine/cli.py <<'JSON'
{"action":"inspect","repoRoot":"examples/demo-project","play":"stock-reservation"}
JSON

python3 engine/cli.py <<'JSON'
{"action":"run","repoRoot":"examples/demo-project","play":"stock-reservation"}
JSON
```

故意失败的场景必须产生失败结果，而不是“查询正常所以通过”：

```bash
python3 engine/cli.py <<'JSON'
{"action":"run","repoRoot":"examples/demo-project","play":"stock-reservation","scenario":"scenario-assertion-fails.json"}
JSON
```

同一支付响应剧本可选择默认拒绝场景或成功场景：

```bash
python3 engine/cli.py <<'JSON'
{"action":"run","repoRoot":"examples/demo-project","play":"payment-response","scenario":"scenario-approved.json"}
JSON
```

这些固定响应样例验证播放器，不是仓储/支付系统的端到端验收，也不能证明幂等或状态机实现正确。

## 新仓库接入

项目可以使用下列目录。无需仓储专用 skill、SAP token 或 Spring health 接口。

```text
<repo>/
  .playtest.json                 # 可选：目标与数据库
  test-plays/<slug>/
    play.json                    # 剧本
    scenario.json                # 默认场景，可选
    scenario-other.json          # 其他场景，可选
  .playtest/runs/<runId>/
    snapshot.json
    events.jsonl
    result.json
```

### 剧本

```json
{
  "version": 1,
  "scenarioName": "外部服务响应验证",
  "mode": "baseline",
  "claims": [{"id":"response", "description":"返回码符合场景", "basis":"已确认的接口契约或基线"}],
  "steps": [
    {
      "stepNo":1, "name":"请求服务", "type":"http", "method":"POST",
      "path":"${mock.service.url}/requests", "body":{"quantity":3},
      "expect":{"status":201,"json":{"$.accepted":true}},
      "extractFromResponse":{"requestId":"$.id"}
    },
    {"stepNo":2,"name":"验证交互次数","type":"mockVerify","mock":"service","method":"POST","path":"/requests","count":1}
  ]
}
```

### 场景

```json
{
  "version":1,
  "variables":{},
  "setup":[],
  "cleanup":[],
  "mocks":[{"id":"service","port":0,"routes":[
    {"method":"POST","path":"/requests","status":201,"body":{"accepted":true,"id":42}}
  ]}]
}
```

`port:0` 请求系统分配空闲端口，避免多个项目争同一固定端口。Mock 的 method/path 匹配和请求记录可验证交互，但不是对真实提供方的契约验证。

### 目标与 SQLite

```json
{
  "version":1,
  "targets":{"local":{"baseUrl":"http://127.0.0.1:8080","description":"用户启动的隔离测试实例"}},
  "databases":{"main":{"driver":"sqlite","path":"${runDir}/fixture.sqlite"}}
}
```

SQLite 的 `${runDir}` 路径是本次独立库；数据库读写不是通过旧脚本执行。其他数据库暂不支持。HTTP 仅允许显式目标与自身 mock 的 origin；不跟随重定向越界。目标白名单不是操作系统级网络隔离。

## 步骤与断言

| 类型 | 参数与含义 |
|---|---|
| `http` / 缺省 | method/path/body/headers；expect.status、expect.json；extractFromResponse |
| `dbQuery` | database/sql/params；expect 为首行列值；extract 为变量到列 |
| `dbWait` | 同 dbQuery，增加 timeoutSeconds/intervalSeconds，直到 expect 满足 |
| `wait` | seconds；仅固定等待，不代表条件满足 |
| `mockVerify` | mock/path/method/count；检查真正发生的交互 |

`${variable}` 整值替换保留 JSON 类型，缺少变量直接失败；不使用 eval。无断言步骤只记录 observed；无有效断言的运行 inconclusive。HTTP 的非 2xx 若显式匹配可通过，但连接/解码错误不能通过。

`explore` 表示观察、`baseline` 表示当前预期比较、`acceptance` 表示业务验收意图。插件执行明确断言，但不验证 basis 语义真实性。用户和 agent 仍需确定规则依据，不应因为模板声明了 acceptance 就信任全部结论。

## 运行、安全与限制

- DSH wrapper 获取当前会话权限，进程经过 `sandbox.confine`；read-only 会话不能写运行证据。授权真实效果不会提升文件权限。
- 预览摘要覆盖配置、剧本与场景内容；运行前再次比较，防止审查后变更。只运行当前内容快照，不在运行中修改断言。
- setup/主步骤失败或 SIGTERM 时仍尝试 cleanup、关闭 mocks；硬杀进程/系统崩溃不能保证清理，缺少终态结果显示 unknown/interrupted。
- `skipCleanup` / 旧 `skipRestore` 保留终态，mock 仍关闭，报告显示 skipped。
- 运行最长 15 分钟；同一仓库单活动运行。HTTP 有界响应、证据有界脱敏；截断会提示，不以截断文本冒充完整证据。
- 数据库/HTTP 会触发的间接业务效果不能完全从 JSON 静态推断。优先独立实例；真实环境要核实目标和权限，不以域名含 test 当安全依据。
- UI 通过原生 Session command 读取运行，每约 2 秒刷新活跃测试；不是 token 级流式界面，也不轮询 agent 状态。
- 仅保证本次范围内的观测，不宣称“证明整个系统正确”或“绝对无副作用”。

## 从旧 test-hub 迁移

存量资产不会自动迁移或重放。旧 `expectFailure:true` 需要改为明确状态码和错误字段；旧 `verification.sqlChecks` 必须转成实际断言步骤；setup/restore 转到独立场景；SAP 鉴权移到当前项目显式配置。先迁移一个小场景，并确认隔离环境后再测试。

## 开发验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_engine.py' -v
node --test tests/test_host.mjs
node --check client.js
```

测试必须验证错误能被抓到，不以语法通过、JSON 合规或截图为业务正确性的证明。安装和浏览器注册也不等于视觉验证；没有连接页面控制时，应明确标注视觉验证限制。
