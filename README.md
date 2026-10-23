# dsh-glm-quota

在 DSH 里盯住 Coding Plan 的额度：目前支持 **GLM Coding Plan**（智谱）、**MiniMax Token Plan** 与 **Kimi Code**（月之暗面）。聊天输入框右下角（切到对应模型时）一组窗口胶囊，侧边栏底部各家一枚百分比徽标，设置里「额度监控」一页完整面板。默认复用你已经配好的模型 Key（`ZAI_CODING_CN_API_KEY` / `MINIMAX_CN_API_KEY` / `KIMI_CODING_API_KEY`），不需要重新填。

```
聊天输入框右下角（GLM 模型时）：  ● GLM 5 小时 42%  ● GLM 每周 7%
                                  （MiniMax 模型时）：● MM 5 小时 60%  ● MM 每周 50%
                                  （Kimi 模型时）：  ● Kimi 5 小时 0%  ● Kimi 每周 0%
侧边栏底部：  ● GLM 42% | MM 60% | Kimi 0%   点一下 = 立即刷新，悬停看各家窗口明细
设置 → 额度监控：每家一组卡片（套餐 / 窗口进度 / 模型明细 / 区域 / Key / 停用开关）
```

## 它显示什么

### GLM Coding Plan

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 5 小时窗口 | `TOKENS_LIMIT` unit=3 | 会话窗口，接口只给百分比与重置时间 |
| 每周窗口 | `TOKENS_LIMIT` unit=6 | 周窗口，接口只给百分比与重置时间 |
| 联网搜索 / 网页读取 | `TIME_LIMIT` | 有绝对值（已用 / 总量 / 剩余） |
| 套餐 | `/api/biz/subscription/list` | 套餐名、状态、是否自动续费、下次续费日 |

### MiniMax Token Plan

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 5 小时窗口 | `model_remains[].current_interval_*` | 按模型聚合出最紧张水位；`end_time` 即窗口重置点 |
| 每周窗口 | `model_remains[].current_weekly_*` | 同上 |
| 模型明细 | 每行一个模型 | 各模型 5 小时 / 每周剩余百分比 |

注意：MiniMax 的用量查询**必须使用 Token Plan 订阅 Key**，普通按量付费 API Key 查不了；部分行（如 `general`）`total=0` 时百分比显示为未知（—），但窗口倒计时仍可用。

### Kimi Code

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 5 小时窗口 | `usages.limit_5h.used_ratio` | 直接给已用比例与重置时间 |
| 每周窗口 | `usages.limit_7d.used_ratio` | 同上 |
| 加量包剩余 | `boosterWallet.balance.amountLeft` | 买了加量包才出现 |
| 并发上限 | `parallel.limit` | 有则显示 |

注意：Kimi 的用量接口（`GET https://api.kimi.com/coding/v1/usages`）校验客户端 UA，插件会伪装成 `KimiCLI/1.6`；旧版响应（`usage`/`limits` 字段）也做了兜底解析。

徽标显示的是**最紧张的那个窗口**（已用百分比最高）。颜色随水位变化：`<70%` 正常、`≥70%` 警示、`≥90%` 标红。侧边栏收成 56px 导轨时只留彩点。

聊天框右下角的胶囊（`conversation.composer.dock`）**只在当前会话使用对应模型时出现**：GLM 模型（provider/name 匹配 `zai|bigmodel|zhipu|glm`）显示 GLM 额度，MiniMax 模型（匹配 `minimax|abab`）显示 MiniMax 额度，Kimi 模型（匹配 `kimi|moonshot`）显示 Kimi 额度，切到其他模型自动隐藏。

## 安装

在本仓库目录下（插件源码即安装目标，改完即时生效）：

```bash
dsh plugin --profile web add /path/to/dsh-glm-quota
```

宿主端会随下一条消息热加载；界面端若没立刻出现，刷新一次窗口即可。

卸载：

```bash
dsh plugin --profile web remove dsh-glm-quota
```

## 配置

设置 → **额度监控** 里可以改（每家 provider 独立）：

- **区域** —— GLM：国内版 `open.bigmodel.cn` / 国际版 `api.z.ai`；MiniMax：国内版 `api.minimaxi.com` / 国际版 `www.minimax.io`。Key 必须与区域匹配，切区域后默认凭证名自动跟随。
- **停用 / 启用** —— 单独停用某一家（徽标与胶囊不再显示它的数据）。
- **刷新间隔**（全局）—— 60 秒 ~ 30 分钟，默认 120 秒。宿主端按此间隔轮询，界面 30 秒读一次缓存。
- **API Key** —— 默认自动复用模型配置里的凭证（GLM 用 `ZAI_CODING_CN_API_KEY`；MiniMax 国内版用 `MINIMAX_CN_API_KEY`、国际版用 `MINIMAX_API_KEY`）。已配好时面板会直接显示"✓ 已自动复用凭证"，**不需要再填**；只有想换 Key 时才点「使用其他 Key…」。粘贴走 DSH 凭证服务，落盘位置与其它 Key 一致。

配置存在 `$DSH_HOME/glm-quota/config.json`（v2，provider 维度；旧版扁平配置自动迁移）；Key 不进这个文件。

## 隐私与开销

- Key 只在宿主端使用，界面端只读 `/dsh-glm-quota/status.json`，永远拿不到明文 Key。
- GLM 每次查询打两个 `GET`（额度 + 订阅，订阅失败不影响额度显示）；MiniMax 打一个 `GET`（主域名失败自动换备用域名重试）。
- 快照缓存 30 秒（错误快照 10 秒，方便配好 Key 后自愈）；每家 provider 独立缓存，同一时刻只允许一个在途请求。
- 界面端 30 秒轮询本地路由，**不直接访问外网**。

## 接口约定（2026-10 实测）

```
GLM     GET {open.bigmodel.cn|api.z.ai}/api/monitor/usage/quota/limit   Authorization: Bearer <key>
GLM     GET {origin}/api/biz/subscription/list                          Authorization: Bearer <key>
MiniMax GET {api.minimaxi.com|www.minimax.io}/v1/token_plan/remains     Authorization: Bearer <订阅key>
```

- GLM 鉴权失败仍是 **HTTP 200** + `{"code":401,...}`，必须看 `body.code`。
- GLM `TOKENS_LIMIT` 的 `unit` 才是判别依据：`3` = 小时窗口、`6` = 周窗口。**`number` 不可信**——文档示例写 7，实际账号返回 1。
- MiniMax 失败看 `body.base_resp.status_code`（`0` = 成功，`1004` = 鉴权失败）；`model_remains[]` 里遗留的 `usage_count` 语义是「剩余」不是「已用」。

## 给 agent 用的工具

宿主端注册了一个 `glm_quota` 工具。你直接问「我额度还剩多少」「MiniMax 还能用多久」时，agent 会调用它拿到各家百分比、重置时间与套餐信息，而不是去猜。可以带 `provider: "glm" | "minimax"` 只查一家，`refresh: true` 强制重查。

## 结构

```
package.json          dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      bundle patch：把插件挂进 profile 的 layer 栈
lib/index.js          宿主端：PROVIDERS 注册表、取数归一化、缓存、轮询、三条 HTTP 路由、glm_quota 工具
lib/client.js         界面端：手写 __ModuleLoader__ wrapper，徽标 + 聊天胶囊 + 设置页
```

宿主端是纯 JavaScript、无构建、无 SDK 依赖，直接 `node --check` 就能验语法。

## 排错

| 现象 | 原因 |
| --- | --- |
| 聊天框右下角没有胶囊 | 当前会话不是 GLM / MiniMax 模型（胶囊只在对应模型时出现）。切过去再看；全新会话从未选过模型时也不会显示，选一次即出现。 |
| 徽标显示 `GLM ?` / `MM ?` | 没有可用 Key，或接口报错。悬停看完整错误。 |
| `Key 无效或已过期` | Key 与所选区域不匹配——国际版 Key 查国内站会 401。 |
| MiniMax 提示必须是订阅 Key | 用量查询只支持 Token Plan 订阅 Key；普通按量付费 API Key 查不了，去 MiniMax 开放平台拿订阅 Key。 |
| MiniMax 百分比显示 `—` | 该模型行 `total=0`（如 general 行），接口算不出百分比；窗口重置倒计时仍有效。 |
| 设置页「未配置」 | 对应凭证为空；先去「设置 → 模型」配对应提供商（Key 自动共享），或在面板里粘贴一个。 |
| 数字长时间不动 | 额度窗口在未消耗时会保持不变（`1%` 很长时间是正常的）；点徽标强制刷新。 |
