# dsh-quota-hub

在 DSH 里盯住 Coding Plan 的额度：目前支持 **GLM Coding Plan**（智谱）、**MiniMax Token Plan**、**Kimi Code**（月之暗面）与 **DeepSeek**（余额+今日花费）。聊天输入框右下角（切到对应模型时）一组窗口胶囊，侧边栏底部各家一枚百分比徽标，设置里「额度监控」一页完整面板。默认复用你已经配好的模型 Key（`ZAI_CODING_CN_API_KEY` / `MINIMAX_CN_API_KEY` / `KIMI_CODING_API_KEY` / `DEEPSEEK_API_KEY`），不需要重新填。

```
聊天输入框右下角（GLM 模型时）：  ● GLM 5 小时 42%  ● GLM 每周 7%
                                  （MiniMax 模型时）：● MM 5 小时 60%  ● MM 每周 50%
                                  （Kimi 模型时）：  ● Kimi 5 小时 0%  ● Kimi 每周 0%
                                  （DeepSeek 模型时）：● DS ¥87.48 · 今日 ¥0.15
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

### DeepSeek（按量付费）

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 账户余额 | `api.deepseek.com/user/balance`（官方） | 充值/赠送/总余额 |
| 今日花费 | 本地估算 | 会话日志 token × 价格表 × 峰谷系数，**非账单** |
| 当前定价区间 | 官方规则实时计算 | 高峰 / 错峰（半价），含今日峰/谷请求数拆分 |
| 模型定价 | 官方价格表 | flash 与 v4-pro 的命中/未命中/输出价 |

注意：DeepSeek 官方不提供"今日已消费"查询接口，今日花费是**本地估算口径**——插件监听本机 DSH 会话日志，把每次请求的 token（缓存命中/未命中/输出/推理）按价格表（元/百万 token）折算；只统计经过本 DSH 的 DeepSeek 请求，其他平台的调用不计入。峰谷规则（官方）：**UTC 周一至周五 01:00–04:00 与 06:00–10:00 为高峰**，其余时段（含整个周末）错峰半价；中国法定节假日豁免未内置。价格单位 USD/1M token：`deepseek-flash` 命中 $0.006 / 未命中 $0.30 / 输出 $1.20，`deepseek-v4-pro` $0.044 / $1.32 / $3.96；可在 `$DSH_HOME/dsh-quota-hub/config.json` 的 `providers.deepseek.prices` 覆盖。数据保留 7 天（`ledger.json`，按 sessionId:seq 幂等去重，重复扫描不会重复计数）。

徽标固定为一枚：**只显示最紧张的那家**（已用百分比最高，DeepSeek 这类无窗口的显示余额）+ `+N` 尾标标出其余家数——无论聚合多少家都不会变宽。点击徽标弹出各家列表浮卡，再点某家进入它的详情面板。

### 独立详情面板

点击侧边栏徽标上的某一段、或聊天框里的某枚胶囊，会打开**这一家 provider 自己的全屏详情面板**（再点空白处或「关闭」收起）：套餐/等级、全部窗口进度条、以及该家独有的扩展信息——DeepSeek 面板包含账户余额、今日花费（按峰/谷拆分）、当前定价区间、模型定价表；设置里的「额度监控」页仍是四家聚合的完整配置入口。颜色随水位变化：`<70%` 正常、`≥70%` 警示、`≥90%` 标红。侧边栏收成 56px 导轨时只留彩点。

聊天框右下角的胶囊（`conversation.composer.dock`）**只在当前会话使用对应模型时出现**：GLM 模型（provider/name 匹配 `zai|bigmodel|zhipu|glm`）显示 GLM 额度，MiniMax 模型（匹配 `minimax|abab`）显示 MiniMax 额度，Kimi 模型（匹配 `kimi|moonshot`）显示 Kimi 额度，切到其他模型自动隐藏。

## 安装

在本仓库目录下（插件源码即安装目标，改完即时生效）：

```bash
dsh plugin --profile web add github:DarkDarkdDarkWine/dsh-quota-hub  # 在线安装（GitHub 直装）
# 或本地开发：dsh plugin --profile web add <本地路径>/dsh-quota-hub
```

宿主端会随下一条消息热加载；界面端若没立刻出现，刷新一次窗口即可。

卸载：

```bash
dsh plugin --profile web remove dsh-quota-hub
```

## 配置

设置 → **额度监控** 里可以改（每家 provider 独立）：

- **区域** —— GLM：国内版 `open.bigmodel.cn` / 国际版 `api.z.ai`；MiniMax：国内版 `api.minimaxi.com` / 国际版 `www.minimax.io`。Key 必须与区域匹配，切区域后默认凭证名自动跟随。
- **停用 / 启用** —— 单独停用某一家（徽标与胶囊不再显示它的数据）。
- **刷新间隔**（全局）—— 60 秒 ~ 30 分钟，默认 120 秒。宿主端按此间隔轮询，界面 30 秒读一次缓存。
- **API Key** —— 默认自动复用模型配置里的凭证（GLM 用 `ZAI_CODING_CN_API_KEY`；MiniMax 国内版用 `MINIMAX_CN_API_KEY`、国际版用 `MINIMAX_API_KEY`）。已配好时面板会直接显示"✓ 已自动复用凭证"，**不需要再填**；只有想换 Key 时才点「使用其他 Key…」。粘贴走 DSH 凭证服务，落盘位置与其它 Key 一致。

配置存在 `$DSH_HOME/dsh-quota-hub/config.json`（v2，provider 维度；旧版扁平配置自动迁移）；Key 不进这个文件。

## 隐私与开销

- Key 只在宿主端使用，界面端只读 `/dsh-quota-hub/status.json`，永远拿不到明文 Key。
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
