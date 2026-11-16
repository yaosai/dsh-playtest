# 结构化数据库适配器 v1

目的：播放器核心不依赖任何业务框架、JDBC 或具体数据库的连接配置。项目提供可信的适配器进程；SQLite 内置适配不变。

## 项目配置

```json
{
  "databases": {
    "main": {
      "driver": "command",
      "argv": ["python3", "tools/playtest-db/adapter.py"],
      "description": "项目 SQL Server 主库（不是元数据存储）",
      "expectedTarget": {"host":"127.0.0.1","port":1433,"database":"database-name"},
      "assetFiles": ["tools/playtest-db/adapter.py", "tools/playtest-db/PlaytestDbQuery.java"]
    }
  }
}
```

- argv 使用参数数组，不使用 shell；可执行名可通过 PATH 查找，任何含分隔符的程序路径及存在的参数文件必须 canonical 位于仓库内（如 python3 为裸名字可通过 PATH；不允许借此注入 shell 任意表达式）。
- assetFiles 是仓库内适配器代码/私有配置依赖，预览只记录其 SHA256，不展示内容；改变任何依赖使 digest 改变。至少适配器脚本及 Java helper 在配置中声明；运行只执行当前匹配摘要的代码。
- command 适配器是可信项目代码，不是安全沙箱。每个使用步骤（包括查询）都报告 requiresConfirmation；由已有 Host 的用户确认/DSH approval 控制，未确认不能启动适配器。
- preview/lint/catalog 只读文件，绝不运行适配器、连接 DB 或解密配置。

## 每步协议

stdin 一个 JSON：

```json
{"version":1,"sql":"SELECT ? AS value","params":[42],"readOnly":true,"allowWrite":true,"runDir":"本次运行目录","expectedTarget":{"host":"127.0.0.1","port":1433,"database":"name"}}
```

- expectedTarget 从配置完整传递，适配器在连接前核对目标。
- readOnly：步骤显式 readOnly=true 或 SQL 被判为 SELECT；不是数据库权限保证，适配器必须拒绝明显写入并建议使用只读账号。
- allowWrite 只由播放器的 allowEffects 来源确定，不能由剧本自行授予。command 适配器执行本身已需要 allowEffects，即便 readOnly。
- runDir 为适配器编译缓存和临时文件位置；程序不得把凭据写入其中。

stdout 一个严格 JSON：

```json
{"ok":true,"rows":[{"value":42}],"rowsAffected":0,"target":{"host":"127.0.0.1","port":1433,"database":"name"}}
```

失败 `{ok:false,error:"脱敏错误",code:"database"}`，非零退出亦失败；不解析 ASCII 表格，不把错误/空输出算通过。rows 必须是字典数组，保留 JSON 类型/null，≤1000 行，stdout≤1 MiB。目标指纹不一致失败。适配器不返回凭据。

stderr 仅有限诊断；生命周期为 PID 回收契约，不依赖进程组权限：引擎以普通直接子进程启动适配器（无 setsid/killpg），terminate→宽限→kill→wait；适配器自己前台等待 javac/java 并安装 SIGTERM/SIGINT 处理器（回收子进程后以退出码 143 自证完成），因此子树由适配器负责回收。引擎据观测结果分类 cleanup：143/正常退出=completed；被 SIGKILL、未处理 -15 或原因不明=unknown；kill 后仍存活=failed，并在事件里说明原因。适配器自身的 JDBC 登录/查询超时是子进程的最终有界保证，不是绝对保证，也不构成安全边界。

## SQL Server 项目实现（本次范围）

真实项目自行提供 `adapter.py` 与 Java helper：复用仓库既有的配置发现与本地解密函数，不调用其旧的执行入口，也不改它的缓存与表格输出。Java 侧使用仓库已有的 JDBC jar，参数化查询，typed JSON 输出；凭据通过进程 stdin 传递，不出现在 argv、运行快照或临时配置文件。异常回滚本步骤，完整消费 JDBC 结果/错误；多个结果集应显式拒绝或明确表示，不隐瞒后续错误。

本次用户已选择“先完成接入、暂时不运行”：可以编译、做本地假适配器回归、解析配置目标，但不能连接/操作真实数据库或调用真实业务接口。最终报告必须保留真实运行未验证的说明。
