# dsh-glm-quota

在 DSH 里盯住 **GLM Coding Plan** 的额度：聊天输入框右下角（GLM 模型时）一组窗口胶囊，侧边栏底部一枚百分比徽标，设置里一页完整面板。支持国内版（bigmodel.cn）与国际版（z.ai），默认复用你已经配好的 `ZAI_CODING_CN_API_KEY`，不需要重新填 Key。

```
聊天输入框右下角（切到 GLM 模型时出现）：  ● 5 小时 42%  ● 每周 7%
侧边栏底部：  ● GLM 42%        点一下 = 立即刷新，悬停看两个窗口的明细
设置 → GLM 额度：套餐 / 5 小时窗口 / 每周窗口 / 搜索额度 / 区域 / 刷新间隔 / Key
```

## 它显示什么

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 5 小时窗口 | `TOKENS_LIMIT` unit=3 | 会话窗口，接口只给百分比与重置时间 |
| 每周窗口 | `TOKENS_LIMIT` unit=6 | 周窗口，接口只给百分比与重置时间 |
| 联网搜索 / 网页读取 | `TIME_LIMIT` | 有绝对值（已用 / 总量 / 剩余） |
| 套餐 | `/api/biz/subscription/list` | 套餐名、状态、是否自动续费、下次续费日 |

徽标显示的是**最紧张的那个窗口**（已用百分比最高）。颜色随水位变化：`<70%` 正常、`≥70%` 警示、`≥90%` 标红。侧边栏收成 56px 导轨时只留一个彩点。

聊天框右下角的胶囊（`conversation.composer.dock`）**只在当前会话使用 GLM 模型时出现**（provider/name 匹配 `zai|bigmodel|glm`），每个窗口一枚，切到其他模型自动隐藏——不占地方也不用去设置里翻。

## 安装

在本仓库目录下（插件源码即安装目标，改完即时生效）：

```bash
dsh plugin --profile web add /Users/darkwine/Documents/deepseek-harness/default-workspace/dsh-glm-quota
```

宿主端会随下一条消息热加载；界面端若没立刻出现，刷新一次窗口即可。

卸载：

```bash
dsh plugin --profile web remove dsh-glm-quota
```

## 配置

设置 → **GLM 额度** 里可以改：

- **区域** —— 国内版 `open.bigmodel.cn` / 国际版 `api.z.ai`。Key 必须与区域匹配。
- **刷新间隔** —— 60 秒 ~ 30 分钟，默认 120 秒。宿主端按此间隔轮询，界面 30 秒读一次缓存。
- **API Key** —— 默认读凭证 `ZAI_CODING_CN_API_KEY`（与 `llm-pi-ai` 的 `zai-coding-cn` 用的是同一个）。已配好时面板会直接显示"✓ 已自动复用凭证"，**不需要再填**；只有想换 Key 时才点「使用其他 Key…」。粘贴走 DSH 凭证服务，落盘位置与其它 Key 一致。

配置存在 `$DSH_HOME/glm-quota/config.json`；Key 不进这个文件。

## 隐私与开销

- Key 只在宿主端使用，界面端只读 `/dsh-glm-quota/status.json`，永远拿不到明文 Key。
- 每次查询打两个 `GET`（额度 + 订阅），订阅失败不影响额度显示。
- 快照缓存 30 秒；同一时刻只允许一个在途请求。
- 界面端 30 秒轮询本地路由，**不直接访问外网**。

## 接口约定（2026-10 实测）

```
GET {origin}/api/monitor/usage/quota/limit      Authorization: Bearer <key>
GET {origin}/api/biz/subscription/list          Authorization: Bearer <key>
```

- 鉴权失败仍是 **HTTP 200** + `{"code":401,...}`，必须看 `body.code`。
- `data.limits[]` 里 `TIME_LIMIT` 带 `usage/currentValue/remaining`；两个 `TOKENS_LIMIT` 只有 `percentage` 和 `nextResetTime`。
- `TOKENS_LIMIT` 的 `unit` 才是判别依据：`3` = 小时窗口、`6` = 周窗口。**`number` 不可信**——文档示例写 7，实际账号返回 1。

## 给 agent 用的工具

宿主端注册了一个 `glm_quota` 工具。你直接问「我 GLM 额度还剩多少」时，agent 会调用它拿到百分比、重置时间与套餐信息，而不是去猜。

## 结构

```
package.json          dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      bundle patch：把插件挂进 profile 的 layer 栈
lib/index.js          宿主端：取数、缓存、轮询、三条 HTTP 路由、glm_quota 工具
lib/client.js         界面端：手写 __ModuleLoader__ wrapper，徽标 + 设置页
```

宿主端是纯 JavaScript、无构建、无 SDK 依赖，直接 `node --check` 就能验语法。

## 排错

| 现象 | 原因 |
| --- | --- |
| 聊天框右下角没有胶囊 | 当前会话不是 GLM 模型（胶囊只在 GLM 模型时出现）。切到 glm 再看；全新会话从未选过模型时也不会显示，选一次 GLM 即出现。 |
| 徽标显示 `GLM ?` | 没有可用 Key，或接口报错。悬停看完整错误。 |
| `Key 无效或已过期` | Key 与所选区域不匹配——国际版 Key 查国内站会 401。 |
| 设置页「未配置」 | `ZAI_CODING_CN_API_KEY` 为空；先去「设置 → 模型」配 GLM 提供商（Key 自动共享），或在面板里粘贴一个。 |
| 数字长时间不动 | 额度窗口在未消耗时会保持不变（`1%` 很长时间是正常的）；点徽标强制刷新。 |
