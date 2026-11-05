# dsh-collab — 同一工作目录下的多智能体协作

一个 DeepSeek Harness 插件：让**同一个工作目录**里的多个 agent（多个会话、子 agent、不同窗口）
共享一块记忆库、一块任务板，并能互相发消息；是否启用**按工作目录单独决定**，默认关闭。

插件本身不写任何全局状态：一切都在 `<工作目录>/.dsh-collab/` 里，是普通文件，
你可以直接用编辑器看、用 git 提交、用 grep 搜索。

## 启用 / 关闭（人类开关）

```
/collab status          查看当前目录是否启用、谁在线、计划与记忆规模
/collab on [名字]       在当前工作目录启动（创建 .dsh-collab/ 并以该名字加入）
/collab off             停止在本目录的协作；文件全部保留，再 on 即可恢复
/collab join <名字>     只改自己的显示名（同伴按名字给你发消息）
```

只有 `on` 会在工作目录里创建文件，所以**不启用时插件完全静默**：没有上下文注入、没有后台写入。

## 四个 agent 工具

| 工具 | 作用 |
|---|---|
| `collab_hub` | `status` 看状态 / `enable` 启动 / `disable` 停止 / `join` 设显示名 |
| `collab_memory` | `write` 写/覆盖一条 Markdown 笔记、`read`、`search`、`list`、`delete` |
| `collab_plan` | 共享任务板：`list` / `add` / `update` / `claim` / `complete` / `delete` |
| `collab_message` | `send` 给同伴发消息（默认唤醒对方）、`inbox` 读未读并标记已读 |
| `collab_session` | 只读别的会话：`list` 列出本目录的会话（在线或已落盘）、`read` 读某个会话最近的 user/assistant 文本、`search` 在某个会话里搜片段（会话索引关闭时自动退化为正文扫描） |

启用后，每个 agent 在**每次模型调用前**都会收到一段有界的协作摘要（本地目录、在线同伴、
未完成任务、未读消息数、记忆条数），不需要人工转述上下文。

## 协作模型

- **同伴发现**：`ctx.agents` 里所有工作目录等于本目录的存活会话都是同伴，无需事先组队。
  名字优先取 `join` 的名字；其次是人类会话的标题；子 agent 用 `agent-<短 id>`（它的标题是任务提示词，
  放进同伴列表只会变成噪音），除非它显式 `join` 过。
- **跨进程可见**：每个 Harness 进程在 `.dsh-collab/presence/<instance>.json` 发布自己的会话心跳
  （内容变化时或每 12 秒写一次，卸载时删除），别的窗口读它来把同伴标成 `other window`；
  `.dsh-collab/` 用 `fs.watch` 递归监听，变化约 200 ms 内进入上下文。心跳超过 20 秒未更新即隐藏。
  发给另一个进程同伴的消息只落盘（`delivery=stored-remote`），对方下一次模型步会看到未读。
- **共享记忆**：一条笔记一个 `<key>.md`，带 frontmatter（title/tags/author/时间），
  人和 agent 都能读；`search` 按标题 > 标签 > 正文加权排序。
- **共同计划**：`plan.json` 是单一事实来源，带 `owner`/`status`/`detail`；
  改文件前先 `claim`，避免两个 agent 抢同一处编辑。
- **消息**：先落盘到对方的 `inbox/<session>.jsonl`，再按对方状态投递：
  运行中 → 下一步看到；空闲 → 默认唤醒它开一轮（`wake:false` 则只排队）；
  不在线 → 只落盘，对方下次打开时在 `inbox` / 摘要里看到。
- **跨会话只读**：`collab_session` 走宿主 `sessionQuery`，按工作目录过滤，
  能列出**在线会话和已落盘的历史会话**，读它们的 surface 文本或做事件级检索。
  只读、有界（默认 12 条消息 / 8 KB）、可用 `allowSessionRead: false` 关掉。
  这让新会话能直接接上旧会话的结论，而不必靠记忆笔记转述。
- **并发安全**：写入用临时文件 + rename；读改写（计划、成员、收件箱序号）用锁文件，
  崩溃留下的锁 10 秒后视为过期。多个 Harness 进程共享同一目录也安全。

## 目录结构

```
<工作目录>/.dsh-collab/
  config.json          # { version, enabled, createdAt, ... }
  members.json         # join 过的显示名
  plan.json            # 共享任务板
  memory/<key>.md      # Markdown 记忆笔记
  inbox/<session>.jsonl        # 点对点消息
  inbox/<session>.state.json   # 已读位置
  presence/<instance>.json     # 每个 Harness 进程的心跳（跨窗口可见）
  events.jsonl         # 审计流水（谁在什么时候改了什么）
```

建议把 `.dsh-collab/inbox/`、`.dsh-collab/presence/`、`.dsh-collab/.lock` 加进 `.gitignore`；
`memory/`、`plan.json` 是否提交由团队决定（提交后就是可 review 的共享上下文）。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `id: collab` 这一行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `wakeIdlePeers` | `true` | 给空闲同伴发消息时是否唤醒它开一轮 |
| `promptContext` | `true` | 是否在每步注入协作摘要 |
| `refreshIntervalMs` | `4000` | 缓存摘要从磁盘重读的间隔 |
| `maxPlanRows` | `40` | `collab_plan list` 最多返回多少行 |
| `allowSessionRead` | `true` | 是否允许 `collab_session` 读取本目录其他会话的正文 |
| `watchHub` | `true` | 是否递归监听 `.dsh-collab/`，让别的窗口的变化在 ~200ms 内反映出来 |

## 安装 / 卸载

在本机 Harness 里：

```
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后 `/collab` 命令与四个工具立即可用（重启后仍在）。卸载用
`plugin_manager action=remove_bundle target=@local/dsh-collab`。

## 边界

- 只协调**同一 Host 进程内**的会话；跨进程的会话能看到 presence 心跳和落盘消息（标记 `other window`），
  但**不能唤醒**对方开新一轮，只能等它下一次模型步读取未读。
  另外 `collab_session` 可以只读别的进程已落盘的会话日志，用来对齐结论。
- `collab_session search` 依赖宿主的会话索引；索引关闭（`session-query` 的 `openAt: never`）时
  自动退化为当前 surface 的正文扫描，命中数仍准确，但没有全文排序。
- 记忆笔记单条上限 32 KiB、最多 500 条；消息单条 8 KiB；任务板 200 条。
  这些是刻意的上界——共享上下文越大，每个 agent 每步付出的 token 越多。
- 插件不做权限判断：能进这个工作目录的 agent 就能读写协作文件。需要隔离时请用
  DSH 的 sandbox / 权限预设，或不要在敏感目录 `/collab on`。
