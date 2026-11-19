# dsh-continuechat

[English](README.md) | 中文

手动继续被中断的 DSH 对话。

当一轮对话因为**手动停止**、**网络或模型请求失败**、或**输出 token 上限截断**而提前结束时，DSH 只在原地留下一个「已停止」标记。这个插件补上缺的那一步：一条 `/continue` 命令，以及被中断的那一轮末尾的「继续对话」按钮，让 agent 从中断处接着干活，而不是重新开始。

## 它解决什么

| 场景 | 不装插件 | 装了这个插件 |
|---|---|---|
| 误触停止 | 只能自己打字「继续」 | 点一下「继续对话」 |
| 网络/接口报错中止 | 需要复述上下文再让它接着做 | 插件把失败原因一并交给模型，直接续跑 |
| 回答被 token 上限截断 | DSH 提示「发送"继续"」但没有任何入口 | 按钮 / 命令一键续写 |

## 用法

### 命令

```
/continue
/continue 剩下的三个文件也一起改掉
```

命令后面可以跟一句补充指令，它会作为「Additional instruction from the user」附在续接提示词末尾。

命令的执行结果（`已请求继续对话（中断原因：手动停止）。`）由 DSH 命令面板渲染，不会变成一条模型消息。

### 按钮

被中断的那一轮，末尾（`turn/end` 之后）会出现一个「继续对话」按钮：

- **只在真正中断时出现**。正常完成、被拦截（`blocked`）、fork 结尾（`forked`）的轮次都不显示，所以它不会出现在正常结束的对话下方。
- 只有最后一轮、且该轮结束时留下了可继续的中断原因时才显示；更早的轮次和正常结束的轮次都返回空，不占位置。
- 该轮即使**没有产出任何 assistant 内容**（请求直接失败、进程在流式输出前就断了、崩溃恢复只剩 `turn/end`）也会显示。
- agent 重新跑起来时自动隐藏。
- 点击后就等于执行了一次 `/continue`。
- 失败时按钮旁会显示一行错误文本（悬停可看完整信息）。

判定读的是会话的持久事件窗口：取最新一条 `turn/end`，只有它的 reason 属于可继续集合、且当前渲染的正是这一轮的尾部时才出现。

### 快捷键与命令菜单

输入 `/` 打开命令菜单，`continue`（标题「从断点继续被中断的对话」）就在列表中；方向键选中、回车执行即可，无需打开输入框历史。

## 工作原理

### 中断检测（host 半侧）

插件订阅会话日志的 `session/event`，跟踪每一轮的 `turn/end`：

| `reason.kind` | 含义 | 视为可继续 |
|---|---|---|
| `aborted` | 运行被中止。`reason.reason.kind` 细分：`user` 手动停止、`parent` 被上级操作取消、`hook` 被钩子取消、`disposed` 会话销毁 | ✅ |
| `error` | 模型请求失败（网络、鉴权、服务端错误…） | ✅ |
| `max-tokens` | 输出被输出 token 上限截断（注意：不是上下文超限） | ✅ |
| `interrupted` | 宿主进程中断后由崩溃恢复合成的收尾 | ✅ |
| `completed` | 正常完成 | ❌ |
| `blocked` | 步骤被 `agent/pre-step` 拦截，未进入 | ❌ |
| `forked` | fork 种子在中断处切分支（新会话的开头） | ❌ |

随后任何一条新的 `user/message` 都会清掉该会话的记录——用户自己接手了，或者插件已经续接过一次。

### 续接提示词

`/continue` 不会只发一个「继续」两个字，而是提交一条结构化的 user 消息：

```
<continue-conversation>
The previous turn ended early: the run was stopped by hand.
Continue the interrupted work in this same session, from exactly where it stopped:
- Do not restart the task, re-summarize, or repeat output and work that is already visible above.
- Treat the current workspace, tool results, and durable session state as authoritative; …
- If a tool call was interrupted, verify its outcome before retrying it, and never blindly retry an operation that may have side effects.
- Finish the remaining work, then verify the result before reporting it.
Failure recorded by the harness: <中断时记录的失败信息>
Additional instruction from the user: <命令后面跟的补充指令>
</continue-conversation>
```

针对中断原因分别改写第一句（手动停止 / 请求失败 / 输出截断 / 崩溃恢复），并把 DSH 记录的失败原文附上，让模型知道**为什么**断的，从而正确决定是接着写、还是先核对工具调用的结果。

### 回答为什么是独立的一条

点击「继续对话」后，DSH 会**新开一轮**让模型续写，然后插件把这一轮的触发提示从对话里回收掉——所以你不再看到那段提示，被打断的回答后面紧跟着新写的内容。

回收用的是一条 `system/message` 替换，而日志把这类事件限定在**步骤**里：`turn`/`step` 必须等于它落盘时打开的那一步，且两个坐标都必须为正（`dsh-session-format-v3-to-v4/lib/index.js` 的 `assertV4SystemMessageFields` 与关系重放）。**已经结束的轮次没有打开的步骤**，替换写不进去。因此回收发生在「模型回答这条提示的那一步」内；如果那一轮没产出回答，则顺延到下一个打开的步骤。

但**新内容无法并进原来那一条回答**。这是 DSH 会话日志的架构约束，不是实现上的取舍：

- 会话日志是事件溯源的，已提交的 assistant 消息不可修改，只能用 surface `replace` 遮蔽。
- `replace` 要求新事件用 `sourceEventSeqs` 列出每一个被遮蔽的节点（`dsh-session/lib/index.js:327`），而 `assistant/message` 被明确禁止携带该字段（同文件 `:313`，因为它内嵌 provider stream）。两条规则冲突，因此没有任何 assistant 类型的事件能做替换。
- 改用 `system/message` 之类遮蔽整个区间，会把区间里的 `tool/call` 与 `tool/result` 一并遮蔽，破坏模型历史的调用配对，下一轮请求会失败。

provider 侧同样没有 assistant 前缀续写（prefill）能力（`dsh-llm-deepseek` 只带 anthropic-beta 相关的 beta 标记），模型无法真的「接着上一条 assistant 消息往下写」，必然生成一条新消息。

所以最终形态是：**没有多余的「继续」提示，但新回答仍是一条独立的消息。**

### 消息形状

续接消息被手工构造为 `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'continue-chat' } }` 并冻结：

- **`id` 必须自带**。`Agent.inbox` 按 `message.id` 去重（重复即抛 `already pending`），且从不补发 id；`id` 用 `node:crypto` 的 `randomUUID()` 生成。
- **`source.kind` 用 `continue-chat`**。Chat 按 source kind 分类 `user/message`：写 `user` 会渲染成人类气泡；其他 kind 渲染为注入的上下文节点，而内容为纯文本的上下文节点完全不进入可见节点集。也不要写 `'plugin'`——那只是格式 v3 的历史形状，v4 读盘时会被拒绝。
- 因此 host 半侧**零外部 import**（只有 `node:crypto`），不需要 `peerDependencies`，也就不受插件版本兼容性拦截的影响。

### 客户端（浏览器半侧）

浏览器侧只做两件事：

1. 注册 `continue-chat` 词典（中/英）。
2. 在 `conversation.chat.turnTail` 插槽注册一个动作。这是 Chat 的「已完成轮次尾部」扩展链，owner props 为 `{ turn, seq, openFile }`，每一轮结束时都会渲染。

不用 `conversation.chat.assistant-actions` 的原因是新版 Chat 的行为：中断时被冻结的部分输出（`assistant/live-chunk`）不会变成带 `messageId` 的持久 `assistant/message`，`assistant/message` 的 `interrupted: true` 分支在客户端也没有 `messageId`，而 `assistant-actions` 只在 `closing.finalNode.messageId` 存在时才渲染；崩溃恢复的轮次则根本没有收尾消息。轮次尾部对每个 `turn/end` 都渲染，因此在所有中断形态下都能承载按钮。

点击后用 `ctx.remote.commands.execute(sessionId, '/continue', [])` 执行宿主命令，和用户手动敲 `/continue` 完全同一条路径，因此命令的生命周期记录、结果渲染、日志都一致。

「当前尾部是否属于被中断的轮次」由会话自身的持久事件窗口回答：`ctx.sessions.binding(sessionId).eventSource` 是一个 `getSnapshot()`/`subscribe()` 的标准 store，插件用 `React.useSyncExternalStore` 订阅它，取最新一条 `turn/end` 的 reason 与轮次编号，和插槽给出的 `turn.turn` 比较。快照按 `revision` 记忆化，因此几十个轮次共用一次扫描，未命中的尾部不会重渲染。

## 安装

插件没有构建步骤：`lib/index.js` 与 `lib/client.js` 就是最终产物，`package.json` 的 `files` 已把安装内容限定为运行时需要的 7 个文件（约 20 KB）。

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add "github:CaiBai-Fish/dsh-continuechat#v0.1.2"
```

`#v0.1.2` 可换成任意 tag、分支或提交；省略则跟随默认分支的最新提交。DSH 的插件安装就是把参数转交给 pnpm，所以 npm / pnpm 也能直接安装：

```powershell
pnpm add "github:CaiBai-Fish/dsh-continuechat#v0.1.2"
```

### 从本地目录安装（开发）

```powershell
dsh plugin --profile desktop add <插件目录的绝对路径>
```

例如：

```powershell
dsh plugin --profile desktop add E:\sourse\plugins\dsh-continuechat
```

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，加载器据此往 profile 插入一行 `continue-chat`；`dsh.client.platform = "web"` 让宿主把 `lib/client.js` 作为浏览器 bundle 提供给 Web 客户端。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-continuechat
```

## 它不做什么

- **不自动继续**。触发永远来自人：命令、按钮，或者（如果你愿意）自己打字。想要自动续跑请用 `goal` 工具。
- **不在正常结束的对话下显示按钮**。判定完全来自会话日志的 `turn/end` reason；「只显示在最新一轮」只为避免旧轮次的按钮指向已经变化的状态。
- **不把新回答并进上一条消息**。架构上做不到，原因见上文；续写始终是一条新的 assistant 消息，插件只回收那条触发提示。
- **不在 agent 运行时插队**。运行中执行 `/continue` 会返回错误提示，请先停止当前轮次。
- **不重写已有历史**。续接只是一条新的 user 消息，追加在日志末尾。
- **不在打开的步骤之外回收提示**。回收写在「回答该提示的那一步」内；若那一轮没有产出回答，则等到下一个打开的步骤。这是日志唯一接受的位置，也是回收不写在 `turn/end` 处理里的原因。
- **不重放历史日志**。插件只观察进程内新追加的会话事件，所以**重启 DSH 后**第一次 `/continue` 会显示「未记录中断原因」，续接提示词退化为通用版本——功能不受影响，只是少了原因细节。
- **不引入任何运行时依赖**。host 半侧只 import `node:crypto`；client 半侧只用平台基座里的 `react`。没有构建步骤，没有 `node_modules`。

## 开发

```powershell
node --test test/host.test.mjs test/client.test.mjs
```

- `lib/index.js` — host 半侧：中断跟踪 + `/continue` 命令。
- `lib/client.js` — 浏览器半侧：手写的 `window.__ModuleLoader__` bundle（无构建步骤）。
- `test/host.test.mjs` — 用一个极小的 cordis 假上下文驱动 host 半侧。
- `test/client.test.mjs` — 用一个极小的 React 假实现驱动浏览器 bundle。
- `tools/inspect-session.mjs` — 解压某个会话日志（多帧 zstd），列出 `/continue` 的触发、遮蔽事件与轮次边界，用来核对 surface 记账：`node tools/inspect-session.mjs <会话目录>/session.v4.jsonl.zstd`。
- `tools/verify-retirement-coordinates.mjs` — 用 harness 自己的 v4 校验器跑三种候选坐标，证明只有落在打开步骤内的替换才会被接受：`node tools/verify-retirement-coordinates.mjs <app 根目录>`。

## 许可

MIT
