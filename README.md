# Playtest：业务测试播放器与观测插件

Playtest 把“剧本（动作与断言）＋场景（环境数据与依赖）＋播放（运行与观测）”接入 DSH。它不是另一个 agent：没有模型调用、没有自主任务循环、没有通用计划审批平台。

已有 coding agent 用方法论调查系统、提出有依据的测试；插件负责可执行校验、步骤播放、mock、确定性断言与证据。没有 LLM 时，Python 引擎也可以独立运行。

## v1.2 能做什么

- 独立的剧本与场景：同一流程切换输入、setup、cleanup 和 HTTP mock。
- HTTP 状态/JSON 字段断言、数据库查询与条件等待、精确 mock 调用次数验证。
- 数据库通过项目侧 **command 适配器**接入：内置 SQLite，另有 SQL Server 适配器示例（见下）。播放器核心不含任何业务库连接规则。
- 显式区分观测、断言通过、断言失败、执行错误与清理情况。
- 保存每次运行的输入快照、NDJSON 事件与结果；不把 lastResponse 写回剧本。
- DSH 原生“业务测试”Conversation View：剧本列表、执行预览、步骤时间线、预期/实际和取消。
- 复用 DSH 的文件权限、进程沙箱、管理进程与必要的用户授权，不自动启动被测服务。
- `cleanupSeconds`（1–180，默认 30）按剧本放宽清理阶段预算；JVM 类适配器建议 60。

### 不做什么

不从代码自动证明业务规则正确；不把 HTTP 200 当作业务成功；不把网络故障当作预期业务拒绝；不提供生产数据修复。没有 Kafka/RabbitMQ 驱动、设备数字孪生、Excel 上传下载断言；SQL Server 适配器只支持单条语句与位置参数。command 适配器的管道 I/O 目前仅 POSIX 可用（其他系统会在启动前失败，不会假装安全）。

**command 适配器是项目侧可信代码**：它能执行任意 SQL，所以只能在你明确点击播放时运行；这不是数据库权限控制。请在适配器里用只读账号与隔离实例兜底，不要依赖 UI 判断。

## 插件规范：一个仓库一个 `.test-plays/`

**约定固定，不做自定义路径。** 插件在一个仓库里的全部足迹只有一个目录：

```text
<git-repo>/
  .test-plays/
    .gitignore             ← 自带：/runs/ 与 /cache/ 不入库（新建时自动生成）
    config.json            ← 目标、数据库接入、场景准备（提交）
    <slug>/                ← 剧本（提交、可评审）
      play.json
      scenario*.json
      NOTES.md             ← 迁移/沉淀来源，或人工判读清单
      *.sql                ← 该剧本自带的 SQL 夹具
    runs/<runId>/          ← 生成：snapshot.json / events.jsonl / result.json
    cache/                 ← 生成：项目适配器编译产物
```

为什么把生成物也放同一个目录，却仍然排除它：目录只有一个，人和工具都不用记三套名字；但**每次播放都会重写运行证据**——把它提交进 git,会带来无意义的 diff、多人并发冲突和仓库膨胀。所以排除规则写在 `.test-plays/.gitignore` 里跟着目录走：新克隆的人不需要改仓库根部的 `.gitignore`,`git status` 也保持干净。

旧布局(`test-plays/` + `.playtest.json` + `.playtest/`)不再被读取;插件会明确报错并给出 `git mv` 步骤,而不是假装"这个仓库没有剧本"。

界面的「仓库」是一个下拉框，内容是当前工作区里发现的 Git 工作树（含 `.git` 的目录，最多两层）；选中后立即读取该仓库根目录的 `.test-plays/`，不需要手填路径。仓库重名或未建 `.test-plays` 也能选，只是列表为空并给出提示。想刷新仓库列表（例如刚 `git clone`）点旁边的「刷新」。

`playtest` 的 `repos` 动作返回同样的列表，agent 也能用它确定该读哪个仓库。发现过程只读、有界、忽略符号链接出界与 `node_modules`/`target` 等噪声目录，不会进入仓库内部继续找嵌套仓库。

## 使用方法

### 在 DSH 中

安装 bundle 后，在当前会话的 View 选择中选择 **业务测试 / Playtest**（与 Chat、Trajectory 并列）。不需要另开服务器或 iframe。

1. 从「仓库」下拉框选一个 Git 仓库；剧本目录自动加载（默认预选第一个带剧本的仓库）。
2. 勾选或点击剧本名即可，**预览会自动生成**（步骤、校验项、目标、mocks、效果与警告）；改仓库/场景/目标也会自动刷新预览。

   剧本列表**不铺开场景说明**（真实场景的说明常有上千字，铺开就没法滚了）：鼠标悬停或键盘聚焦在剧本行上会浮出完整说明，预览卡里的「场景说明」默认折叠。触屏或不用悬停时，点选剧本后展开预览卡里的折叠项即可。
3. 预览卡顶部的操作条常驻「开始播放」，**点它即开始**，没有额外的确认勾选。自身 HTTP mock 示例不触碰外部系统；真实目标调用或非运行目录内的数据库写入，其影响会列在预览的「预期影响」里供你查看。

   点击仍会带上你刚才看到的那份快照摘要：如果选择、场景、目标或资产在这之后发生变化，播放会拒绝并用最新预览重新对齐，避免「看到 A、跑了 B」。这个动作不扩大文件/网络权限；页面刷新后不保留任何授权状态。
4. 看断言、执行、清理三个结果，以及每步的证据。取消后也应查看最终清理情况。

工具与 UI 使用同一组 Host 操作：

| 工具 | 用途 |
|---|---|
| `playtest` | `catalog` 列出；`inspect` 预览；`runs` 历史；`read` 读步骤/事件；`cancel` 停止 |
| `playtest_run_play` | 启动单个剧本，立即返回 runId；不是返回“已通过” |
| `playtest_run_suite` | 顺序运行选定或全部剧本，返回统一 runId |
| `playtest_lint` | 检查结构，不执行业务动作 |
| `playtest_new_play` | 新建业务剧本骨架（`example: true` 生成自带 mock 的可播放示例） |
| `playtest_save_play` | 把一次已记录运行沉淀为新剧本，观察值逐条标注来源 |

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

新仓库只需要一个目录,由 `playtest_new_play` 或界面「新建剧本」自动创建(含自带排除规则的 `.gitignore`),无需手工搭建:

```text
<repo>/.test-plays/
  .gitignore             # 自动生成:/runs/ /cache/
  config.json            # 可选:targets / databases / prepare
  <slug>/play.json       # 剧本
  <slug>/scenario.json   # 默认场景；scenario-*.json 为变体
```

`runs/<runId>/{snapshot.json,events.jsonl,result.json}` 由播放写入,已被上面的 `.gitignore` 排除。

### 剧本

`scenarioName` 就是界面上剧本列表显示的标题：写成**一句业务目标**（例：「整托 工作站下线批次回退全链路」），不要写目录名或接口名。`description` 是悬停/聚焦时展开的场景说明，长内容不会铺开在列表里。

```json
{
  "version": 1,
  "scenarioName": "外部服务响应验证",   // 界面标题;新建时就是你输入的那句话
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

### 目标与数据库

```json
{
  "version": 1,
  "targets": {"local": {"baseUrl": "http://127.0.0.1:8080", "description": "用户启动的隔离测试实例"}},
  "databases": {
    "fixture": {"driver": "sqlite", "path": "${runDir}/fixture.sqlite"},
    "main": {
      "driver": "command",
      "argv": ["python3", "tools/playtest-db/adapter.py"],
      "expectedTarget": {"host": "127.0.0.1", "port": 1433, "database": "your-db"},
      "assetFiles": ["tools/playtest-db/adapter.py", "tools/playtest-db/YourDbBridge.java"]
    }
  }
}
```

- `sqlite` 的 `${runDir}` 路径是本次独立库，适合验证播放器自身；它不是任何业务库的替代品。
- `command` 由项目提供可信适配器：argv 是参数数组（禁 shell/`-c`/`-e`），依赖文件必须位于仓库内，`assetFiles` 在快照里**只留哈希**（私有配置内容不展示），任何依赖变化都会改变 digest 并要求重新预览。
- 适配器协议见 `DB-ADAPTER.md`：stdin 收 `{version,sql,params,readOnly,allowWrite,runDir,expectedTarget}`，stdout 回 `{ok,rows,rowsAffected,target}`。空输出、表格文本、字段缺失或非零退出都不算通过。
- `expectedTarget` 由适配器在连接前自行核对；播放器只能核对适配器回传的指纹。目标白名单不是网络隔离。
- HTTP 仅允许显式目标与自身 mock 的 origin，不跟随重定向。

### SQL Server 示例适配器

`demo-biz-repo` 的接入位于 `tools/playtest-db/`：`adapter.py` 复用项目既有配置发现与本地解密，`PlaytestDbQuery.java` 用仓库已有 JDBC jar 执行参数化查询并输出 typed JSON。凭据只通过进程 stdin 传递，不写 argv、快照或临时文件；`--describe` 与 `--compile-check` 都不连接数据库。每条 SQL 会启动一次适配器进程，因此单步成本包含 JVM 冷启动；跨步骤复用连接属于后续工作。

## 已接入的真实场景：demo-biz-repo 工作站生命周期

原 `docs/mock/station-lifecycle/mock_config.json` 保持不变，新协议资产位于 `demo-biz-repo/.test-plays/station-lifecycle/`：

| 文件 | 用途 |
|---|---|
| `play.json` | 11 步业务流程：停接单→恢复→下线→复上线→重复上线被拒；文字 `expect` 改为显式 `expect.status/json` |
| `scenario.json` | **严格原基线**：要求起点已 ONLINE+接单，否则前置失败即停（不自动归一化） |
| `scenario-from-offline.json` | 起点离线的本地状态：先用业务接口 `loginWithRule` 上线，再播放；收尾恢复本轮记录到的原始字段 |
| `scenario-current-code.json` | 把“下线后接单标志”预期改为 0（当前源码 `登出流程` 会先停接单），供业务确认后选用 |

播放前用 `playtest(action="inspect")` 查看目标与效果；SQL Server 的每一步（含只读查询）都需要用户授权，因此该场景不能在无人值守下运行。收尾的 UPDATE 只在字段确实变化时写入，并单独核对；操作日志、站锁、暂存托盘归位等副作用不在恢复范围内，结果会明确写出这一点。

### 首次真实播放记录（runId `7b1093c36371447bb92ed6c39c4f802e`）

结果：**断言 failed / 执行 completed / 清理 completed**，28 条断言中仅 1 条不匹配。

| 步骤 | 结果 |
|---|---|
| setup 1–5（记录原状态、无活动单据、业务接口上线、等待在线） | 全部通过 |
| play 1–6（停接单→在线保持、恢复接单、下线） | 全部通过，接口 `success=true` 与库表状态一致 |
| **play 7 下线后状态** | **失败：`is_accept_bill` 期望 1、实际 0**（`runtime_model=OFF_LINET`、`activate_rule=NULL` 符合预期） |
| play 8–11 | 未执行：播放器在第 7 步按 fail-fast 停止，这是设计行为 |
| cleanup 1–2 | 恢复 UPDATE 影响 0 行（起点本就是离线下线后同状态），核对断言通过；工作站回到本轮开始时记录的 OFF_LINET/0/NULL |

这条差异是**基线漂移**：旧 `docs/mock` 场景断言下线后接单标志仍为 1，而当前实现的 `登出流程` 在下线前先停止接单。插件没有为了让结果变绿改写断言，而是保留失败结果，并把预期为 0 的候选基线单独放在 `scenario-current-code.json`；是否把它定为正式基线需要业务确认。该变体已改为“先业务上线再播放”，因此可以完整执行到步骤 11。



## 创建测试场景

插件提供两个**写入资产**的动作,都拒绝覆盖已有剧本:

| 动作 | 界面 | agent 工具 | 产出 |
|---|---|---|---|
| 新建骨架 | 工具条「新建剧本」→ 一句话 → 创建 | `playtest_new_play` | `.test-plays/<slug>/`:`mode: explore`、无步骤、`NOTES.md` 列出要补齐的四件事 |
| 从运行沉淀 | 运行面板「把这次运行存为剧本」→ **一次点击,零输入** | `playtest_save_play` | 复制那次运行的剧本与场景,给**没写过的**字段填入观察到的实际值,并在 `NOTES.md` 逐步登记来源 |

**一句话之后发生什么**:创建 = 建骨架 + `session.create({cwd: 仓库})` 另起一个 agent 会话 + `session.prompt` 把目标交给它。提示词里写死了约束:先读代码与契约、不许猜字段、依据进 `claims[].basis`/`NOTES.md`、口径未确认就保持 `explore`、自查用 lint/inspect、**不得自行发起打真实系统的播放**。所以那一刀仍然归你在界面点。宿主构建若没有 session 命名空间,按钮退化为"骨架已建 + 告你下一步怎么说",不会静默失败。

**为什么不问目录名和目标**:目录名由这句话推出(取其中的英文/数字词做 kebab 名,纯中文则落 `play-<哈希>`,可读标题保存在 `play.json` 的 `scenarioName` 里,列表显示的就是它);仓库只声明了一个 target 时直接用它,声明了多个或没有时才留空——**在两个服务之间替人选是人的决定,不是工具的技巧**。

`playtest_new_play(example: true)` 仍生成自带本地 mock 的可播放示例(不碰外部系统),用于第一次理解资产结构。

**沉淀的规则(为什么这样设计):**

- 新生成的剧本永远是 `mode: explore`——它记录的是"上次系统这样做",不是"业务要求这样"。
- 只补原来没有断言的字段;已有的预期一律保留,不覆盖作者写的值。
- 失败步、证据被截断、值被脱敏、状态码 ≥400、响应里的密钥类字段——**一律不写成预期**,只在 `NOTES.md` 说明原因。把缺陷或秘密洗成基线比没有基线更糟。
- 每步最多写 8 个字段;响应只取顶层标量(数组/对象不猜)。
- 变量、造数、恢复、mocks 原样复制自那次运行的场景,这样起点和收尾一致。
- 核对 `NOTES.md` 后,你手动把 `mode` 改成 `baseline`(与已记录预期比较)或 `acceptance`(按已确认规则验收,并补 `claims[].basis`)。

**不提供步骤表单编辑器。** 断言的业务含义来自需求、接口契约或已确认案例——那是你和 agent 读代码/文档判断的事;插件负责把已有事实变成可检查、可复核的资产,并把每个预期的来源写清楚。做一个表单编辑器会把它变成第二个配置系统,而且更容易造出看起来正确、实际无效的断言。

## 跑失败了：把证据交给 agent 分析

运行结论不是「通过」时（verdict 非 passed、执行 blocked/failed、清理失败，或有步骤未通过），运行面板出现**让 agent 分析这次失败**。它同样走 `session.create({cwd})` + `session.prompt`，交接的内容是**那次运行的身份与失败明细**（runId、剧本名、结论三元组、证据目录、未通过步骤及其断言消息），并写死四条纪律：

1. **先读证据再归因**：用 `playtest read <runId>`，不够再读 `.test-plays/runs/<runId>/events.jsonl` 与 `result.json`；不许凭步骤名猜。
2. **只归一类**：①剧本/断言写错 ②环境或夹具不满足前置 ③真实业务缺陷——并说明证据里是什么支撑这个判断。
3. **禁止为了让徽章变绿而动手**：放宽或删除断言、把预期改成实际值、把失败步骤降级成"只记录"都不行。判定为业务缺陷时**不许动剧本**，只报告证据与建议。
4. 改完跑 `playtest_lint` + `inspect` 自查，**重新播放那一下仍归用户点**。

通过的运行不提供这个按钮——没有失败可分析；想让 agent 从一次成功里沉淀基线，用的是「把这次运行存为剧本」。

## 鉴权头属于 target，不属于剧本

真实系统往往要求 `Authorization` 之类的头。它回答的是"我在跟哪个服务说话"，所以声明在 `targets.<name>.headers`，一次声明、所有剧本与场景共享，凭据不会散落在测试资产里。三条规则：

- **步骤自己的头优先**：`step.headers` 覆盖同名 target 头，临时换令牌不用动配置。
- **同源才发**：只有当这一步**实际请求的 URL**（含步骤写死的绝对 URL）与 target 的 `baseUrl` 同源于同一 `scheme://host:port` 时才附加；指向自己 mock 的步骤、或写别的主机的绝对 URL，**拿不到这个凭据**。移除该守卫时测试会失败（不是空过的断言）。
- **`Host` / `Content-Length` / `Connection` / `Transfer-Encoding` / `Expect` 被拒绝**：那些由传输层拥有，写进来只会让资产看着合法、发出去坏掉。

## 场景与目标用下拉选，不用打字

`catalog` 返回每个剧本的场景文件列表、它自己声明的默认场景（`play.json` 的 `"scenario"`），以及仓库 `.test-plays/config.json` 里声明的目标名。界面据此渲染两个下拉框：

- **场景**：第一项是「用剧本自己的默认场景」，其余是这个剧本真实存在的文件，剧本默认那个标「（默认）」。选中即重新预览。
- **目标**：第一项「用剧本自己的目标」，其余来自配置。
- 选了多个剧本时，只有它们**都有**的场景文件才可能生效；一个都不共用就禁用下拉并说明原因，而不是发一个必然对其中一个报错的文件名。
- 目录数据里缺 `targets` / `scenarios`（旧引擎）时退回输入框，不让界面空掉。

## 播放的四个阶段

一次播放固定按这个顺序走，界面也按阶段分组显示（运行 tab）：

| 阶段 | 谁提供 | 内容 |
|---|---|---|
| ① 场景准备 `prepare` | **项目**（`.test-plays/config.json`） | 只读就绪检查：服务是否在线、数据库是否可访问 |
| ② 数据准备 `setup` | 场景文件 | 本轮需要的数据与起点状态 |
| ③ 步骤执行 `steps` | 剧本 | 业务动作 + 每步内嵌校验 |
| ④ 收尾清理 `cleanup` | 场景/剧本 | 恢复本轮改动的字段 |

**「跑之前要先有的东西」分两处放，别混。** 判据是**作用域 + 有没有写副作用**：

| 东西 | 放哪 | 为什么 |
|---|---|---|
| 服务在不在线、库能不能连 | `prepare`（仓库级，**只读**） | 全仓库共用；插件按方法/语句拦写（GET/HEAD/OPTIONS、SELECT），失败即 `blocked` 且保证没动过数据 |
| 库位、货架、点位、物料、实现配置 | `scenario.setup`（**场景级，会写**） | 每种入库要的形状不同：整托 要可选点位与搬运自动完成配置，整箱 要 整箱 货架/库位与 整箱库 仓库地点配置 |
| 本轮造出来的数据怎么撤 | `scenario.cleanup` | 与 setup 成对，避免下次播放撞上轮 |

把夹具塞进 `prepare` 会同时踩三个坑：写操作被 lint 拒绝；三种场景被迫共用一套夹具，差异没地方放；而"prepare 失败 = 什么都没动"这个承诺也不再成立。多个场景共用的主数据不必抄三份——写成剧本目录里的一个 `.sql`，各场景用 `sqlFile` 引用它（内容计入摘要，改了 SQL 旧预览就不能再播）。

**插件不猜「就绪」是什么意思，由项目声明。** 声明在 `.test-plays/config.json` 顶层：

```json
{
  "targets": { "local": { "baseUrl": "http://localhost:8080", "headers": { "Authorization": "Bearer <项目自己的开发令牌>" } } },
  "databases": { "main": { "driver": "command", "argv": ["python3", "tools/playtest-db/adapter.py"], "expectedTarget": {"host":"127.0.0.1","port":1433,"database":"your-db"}, "assetFiles": ["tools/playtest-db/adapter.py"] } },
  "prepare": [
    { "stepNo": 1, "name": "业务服务在线", "type": "http", "target": "local", "method": "GET", "path": "/health/check", "expect": { "status": 200 } },
    { "stepNo": 2, "name": "SQL Server 主库可访问", "type": "dbQuery", "database": "main", "readOnly": true, "sql": "SELECT 1 AS ok", "expect": { "ok": 1 } }
  ]
}
```

规则：

- 只允许 `http`（GET/HEAD/OPTIONS，无请求体）、`dbQuery`、`dbWait`，且**必须写 `expect`**——没有预期就不算「证明就绪」。
- 数据库检查必须只读（SELECT）。造数属于 ②数据准备，不属于场景准备。
- 每个剧本执行前都会跑一次自己的场景准备：不同剧本的目标可能不同，就绪与否必须各证各的。
- 场景准备的失败**不算业务失败**：结果记 `execution: "blocked"`（环境未就绪）、`verdict: "inconclusive"`、`cleanup: "skipped"`，进程退出码 2；后续的 ②③④ 不再执行，因为什么都没改，无需清理。
- 场景准备同样计入「预期影响」，需要真实请求或适配器调用时会照实列出，不偷偷跑。

## 步骤与断言

| 类型 | 参数与含义 |
|---|---|
| `http` / 缺省 | method/path/body/headers；expect.status、expect.json；extractFromResponse |
| `dbQuery` | database/sql/params；expect 为首行列值；extract 为变量到列 |
| `checks` | 挂在任一动作步骤上的内嵌校验（`dbQuery`/`dbWait`/`mockVerify`），决定该步骤状态 |
| `dbWait` | 同 dbQuery，增加 timeoutSeconds/intervalSeconds，直到 expect 满足；只写 `extract` 时表示“等行出现” |
| `wait` | seconds；仅固定等待，不代表条件满足 |
| `mockVerify` | mock/path/method/count；检查真正发生的交互 |
| mock route `method` | 可为 `"*"`，应答任意方法（迁移旧桩时需要，旧桩 GET/POST 通吃） |

`${variable}` 整值替换保留 JSON 类型，缺少变量直接失败；不使用 eval。无断言步骤只记录 observed；无有效断言的运行 inconclusive。HTTP 的非 2xx 若显式匹配可通过，但连接/解码错误不能通过。

### 校验写在步骤里（checks）

**一个业务步骤 = 一个动作 + 它自己的校验。** 校验不会变成独立步骤，只决定该步骤的状态：

```json
{
  "stepNo": 3, "name": "工作站下线", "type": "http", "method": "POST",
  "path": "/api/station/pc/logOut", "body": {"macAddress": "${station}"},
  "expect": {"status": 200, "json": {"$.success": true}},
  "checks": [
    {"name": "下线后状态符合基线", "type": "dbWait", "database": "main", "readOnly": true,
     "sql": "SELECT runtime_model FROM ... WHERE park_id = ? AND code = ?",
     "params": ["${parkId}", "${station}"],
     "expect": {"runtime_model": "OFF_LINET"}, "timeoutSeconds": 30, "intervalSeconds": 2}
  ]
}
```

规则：

- `checks` 只能放**校验**：`dbQuery`、`dbWait`、`mockVerify`。动作（`http`/`wait`）做校验会被拒绝，`checks` 不能嵌套。
- 「无断言」警告只看业务步骤：场景准备（`prepare`）证明的是环境就绪，不会把一个没有业务断言的剧本显示成已验证。
- 步骤状态：动作与所有校验都通过才 `passed`；任一校验不匹配 → 该步骤 `failed` 并停止后续步骤；校验本身报错（连不上库、SQL 错）→ 步骤 `failed` 且带 `errorCode`，与"断言不匹配"区分开。
- 界面上只列业务步骤，校验项以名称+状态的明细列在该步骤下（不显示断言数）；查询、轮询与报错仍完整记录在事件里。
- `dbWait` 在 `checks` 里通常更合适：接口返回成功不代表数据已就位。
- 初始状态检查放 `setup`，恢复检查放 `cleanup`，跨多个动作的不变量才单独做流程级校验。

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

迁移是**一次性转换**，不是持续同步：迁完之后 `.test-plays/` 里的剧本就是手工维护的源，旧资产留在 `docs/mock/**` 只做出处。

按实际语义逐条处理，不按字段名照搬：

- **结构化 `expect`（字典）** 直接迁成断言——这是旧场景里唯一被机器比较过的部分。
- **散文 `expect`（中文字符串）** 不猜成断言：原文进剧本目录的 `NOTES.md`。旧 runner 同样只把它打给人看。
- **`verification.sqlChecks`** 保持人工判读，写进 `NOTES.md`。旧 `run_evals.py` 明确标注它"信息性、从不比对预期"，自动转成断言等于凭空造验证强度。
- **`expectFailure:true`** 删除该标记。只有当旧场景记录了真实响应体且含 `success` 字段时，才转成"断言业务拒绝"（不断言中文文案，那会变）；其余在 `NOTES.md` 记为缺口。
- **`setup.sqls` / `restoreSqls`** 转成 `scenario.setup` / `scenario.cleanup`；引用 `.sql` 文件的按整批一条步骤保留（`sqlFile`，内容计入摘要），不拆成语句——拆开会为每条语句付一次适配器冷启动。
- **`mockServer` 步骤** 转成 `scenario.mocks`，`method` 用 `"*"`（旧桩 GET/POST 通吃，强制精确匹配会漏应答）。

转换工具放在**项目侧**（例：`tools/playtest-migrate/legacy_mock.py`），因为认识旧格式的是这个仓库，不是通用插件；插件只接 `create` / `save_play`。它必须**默认跳过已存在的剧本**（重写单个要显式 `--force <slug>`），否则谁顺手重跑一次，就会把别人手工补的断言静默抹回旧形状。

先迁一个小场景，在隔离环境里确认结构合法再谈播放；**迁移完成不等于播放通过**——没播过的剧本只是可解析的资产。

## 开发验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_host.mjs tests/test_render.mjs
node --check client.js
```

`tests/test_render.mjs` 会在 Node 里真正执行视图工厂并渲染一棵树（自带最小 hooks：状态、依赖缓存、可冲刷的定时器）。结构正则挡不住渲染期的 `ReferenceError`——那会让整个面板白屏，只有实际渲染才能抓到。

测试必须验证错误能被抓到，不以语法通过、JSON 合规或截图为业务正确性的证明。安装和浏览器注册也不等于视觉验证；没有连接页面控制时，应明确标注视觉验证限制。
