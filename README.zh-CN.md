# dsh-web-search-ddg

[![许可证: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/release/korosu/dsh-web-search-ddg?label=release)](https://github.com/korosu/dsh-web-search-ddg/releases/latest)
[![dsh tested](https://img.shields.io/badge/dsh%20tested-0.2.0--rc.1-3068a8?logo=deepseek&logoColor=white)](#版本兼容性)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

[English](README.md) | 中文

## 概述

这是一个 out-of-tree 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）捆绑包，把内置 `web_search` 工具背后的后端换成对 DuckDuckGo 静态 `html.duckduckgo.com` 结果页的抓取：无需 API 密钥，无需辅助模型请求，每次查询不消耗 token。它以 `ddg` 搜索提供方身份注册到 `ctx.web` seam，因此面向模型的 `web_search` 工具保持完全相同的 schema 与呈现方式。

当部署没有可消耗的搜索密钥——或认为每次查询一个模型轮次过于昂贵——时选择它。反复被限流会触发失败预算，使提供方在冷却期内退到一旁，因此受质询的网络会降级为 seam 的提供方选择，而不是无声的空结果。面向模型的工具位于 `dsh-tool-web`；本包只提供后端。

## 安装

一条命令，其余什么都不用改。

```bash
dsh plugin --profile web add github:korosu/dsh-web-search-ddg
```

本地克隆的安装方式完全一样——把同一条命令指向检出目录即可：

```bash
dsh plugin --profile web add /path/to/dsh-web-search-ddg
```

Release tarball 也可以从 URL 安装——每个 release 都以同一个固定名字附带它，所以这个 URL 不随版本变化：

```bash
dsh plugin --profile web add https://github.com/korosu/dsh-web-search-ddg/releases/latest/download/dsh-web-search-ddg.tgz
```

把 `latest` 换成 tag 即可固定版本（`.../releases/download/v0.1.4/dsh-web-search-ddg.tgz`）。三种形式安装的都是同一份预构建 `lib/`，区别只在来源。

仅此而已，因为 `dsh plugin add` 自己就把全部工作做完了：

1. profile 尚不存在时，它会在 `$DSH_HOME/profiles/web` 初始化 profile。
2. 它把参数转发给 profile 目录下的 `pnpm`，因此包及其运行时依赖（`cheerio`、`@deepseek-ai/schemastery`）会被安装。
3. 它读取本包的 `dsh.bundle.patch` 声明，把 `dsh-web-search-ddg` 追加到 profile 的 `dsh.profile.bundles` 列表。
4. Loader 随后把 `cordis.patch.yml` 作为 patch 层应用，挂载提供方并切换搜索固定。

你**不需要**编辑 profile 自己的 `cordis.patch.yml`——那只会遮蔽本捆绑包的层。无需启动即可验证，然后重启宿主（host 侧插件行不会热重载）：

```bash
dsh --profile web --dump-config | grep -A2 searchProvider
dsh web
```

应当看到一个标记为 `# == dsh-web-search-ddg` 的层和 `searchProvider: ddg`。

### 本捆绑包如何改变组合

`cordis.patch.yml` 携带两行：

- 一个 `insert`，挂载本包并注册 `ddg` 搜索提供方；
- 一个覆盖，把 base 的 `web` 行固定为 `searchProvider: ddg`。

patch 行**替换目标行的整个 `config`**——没有深度合并——因此覆盖必须重述 base 行拥有的每个键。已发布的 base 行（`@deepseek-ai/dsh-base`）同时拥有 `searchProvider` 与 `fetchProvider`，所以该行必须带上 `fetchProvider: http`，即使抓取后端并未改变。

### 回滚

两种方式都是一行操作。

```bash
dsh plugin --profile web remove dsh-web-search-ddg
```

或者保留本捆绑包，在 profile 自己的 `cordis.patch.yml` 中恢复内置后端：

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

切换两侧都不删除任何东西：已发布的 `web-search-deepseek` 行保持挂载，因此 DeepSeek 后端仍然注册且可用。

### 为何不需要构建许可

`lib/` 以预构建形式随仓库发布——它被纳入版本控制，而不是在安装时生成——且本包不声明 `prepare` 脚本，因此从 GitHub 源、本地路径或 tarball 安装都不会执行本包的构建。无需添加任何 `allowBuilds` 条目，安装时也不会有任何生命周期脚本在你的机器上运行。

本地目录安装是 `link:` 依赖，同样不会运行生命周期脚本。但它确实需要插件**自己**的 `node_modules`：符号链接按模块的**真实**路径解析它的导入，因此 `cheerio` 与 `@deepseek-ai/schemastery` 会在插件目录中查找，而不是在 profile 的 `node_modules` 中。请在插件目录里运行一次 `pnpm install`——`lib/` 已纳入版本控制所以不会触发构建——但删除 `node_modules` 又跳过安装会让提供方在加载时以 `ERR_MODULE_NOT_FOUND` 失败。

若要固定所装内容，请固定提交（`github:korosu/dsh-web-search-ddg#<sha>`）；GitHub Release 附带的 tarball 与该提交携带同一份预构建 `lib/`。

### profile 层级的 peer 警告

profile 是一个以 `autoInstallPeers: false` 解析的 pnpm workspace，因此 `dsh plugin add` 可能会打印警告，说本插件的 peer（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-web`）在 profile 层级找不到。这个警告是表面性的——运行中的宿主从它自己的树里提供这两者，插件也通过它解析——但可以在 profile 的 `pnpm-workspace.yaml` 里静默：

```yaml
peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/cordis'
    - '@deepseek-ai/dsh-*'
```

## 配置

所有键都是可选的，写在 `insert` 行的 `config` 中。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `https://html.duckduckgo.com/html/` | 结果端点，追加 `?q=`。必须是绝对 `http(s)` URL；其他任何值都会使提供方不可用 |
| `maxResults` | （未设置） | 解析时施加的行数上限，且仅在请求未携带 `maxResults` 时生效，必须是正整数；其他任何值都会使提供方不可用。它统计的是已解析行，所以页面开头的垃圾行可能把有效行挤出截断点 |
| `failureThreshold` | `3` | 连续多少次瞬态失败后，提供方把自己声明为不可用，让 seam 去选择别的后端。必须是正整数 |
| `cooldownMs` | `300000`（5 分钟） | 上述不可状态的持续时间，以毫秒计。必须是正整数 |

完全不涉及任何凭据——本提供方天然免密钥，因此没有设置卡片、没有 API 密钥字段，也没有凭据解析步骤。

### 选择提供方

本捆绑包对 `web` 行的覆盖固定了 `searchProvider: ddg`，这正是让一条命令的安装切换后端的原因。seam 同样接受含义相同的环境变量——设置

```bash
export DSH_WEB_SEARCH_PROVIDER=ddg
```

无需触碰任何 patch 行即可固定提供方；两者同时设置时 config 键获胜。当注册了不止一个搜索后端时，固定（任一形式）让 seam 解析到 `ddg`；不固定则两个可用后端触发 `WEB_PROVIDER_AMBIGUOUS`。取同理，`DSH_WEB_FETCH_PROVIDER` 管抓取，本捆绑包让它保持在内置 `http` 后端。

### 一次搜索返回什么

结果页的每一行映射为一个 `WebSearchSource`：`url`、`title`，以及非空白时的 `snippet`。标题为空或 URL 不可用的行会被丢弃，重复项收敛到首次出现的 URL，因此一次调用返回的条数可能少于请求数量。

DDG 结果链接是协议相对的重定向跳转（`//duckduckgo.com/l/?uddg=<encoded>&rut=...`）。本提供方把 `uddg` 解码回真实目的地，因此工具引用的是实际页面而非中间 URL。这是纯字符串操作——结果跳转永远不会被抓取。

本提供方始终报告 `truncated: false`。当请求携带 `maxResults` 时，本提供方把自己的解析截断到该数值，因此永远不会过量返回，seam 也无从截断——即使页面实际包含的行数多于请求数，该标志仍为 `false`。**配置级**的 `maxResults` 以同样的方式在解析时生效，同样对调用方不可见。DDG 静态标记既不携带生成答案也不携带发布日期，因此永远不会产出 `content` 或 `publishedAt`。

### 失败与恢复

| 情形 | 结果 |
| --- | --- |
| 网络失败、正文不可读 | `WebError` `WEB_PROVIDER_ERROR`，计入失败预算 |
| HTTP 403 / 429 / 5xx | `WebError` `WEB_PROVIDER_ERROR`，计入失败预算 |
| 其余 HTTP 非 2xx | `WebError` `WEB_PROVIDER_ERROR`，**不计入**——配置型失败重试结果完全相同 |
| 质询／异常页面（HTTP 202，无结果标记） | `WebError` `WEB_PROVIDER_ERROR`，指明异常页，计入失败预算 |
| 请求被中止 | `WebError` `WEB_ABORTED`，永不计入 |
| 失败预算耗尽（连续 `failureThreshold` 次瞬态失败） | 提供方在 `cooldownMs` 内声明自己不可用。固定的部署看到 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；未固定的部署回退到任何其他已注册后端，若没有则得到 `WEB_PROVIDER_UNAVAILABLE` |
| `endpoint` 不是绝对 `http(s)` URL，或数值配置不是正整数 | `WebError` `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` —— 已注册，但拒绝运行 |
| 保留固定却移除了本捆绑包 | `WebError` `WEB_PROVIDER_CONFIGURED_MISSING` |
| 两个搜索后端都注册着却移除了固定 | `WebError` `WEB_PROVIDER_AMBIGUOUS` |

HTTP 重定向由原生 fetch 跟随，因为端点会在裸域与 `html/` 路径之间迁移。中止——名为 `AbortError` 的 `DOMException`，或已中止的信号——变为 `WEB_ABORTED`；其余一切变为 `WEB_PROVIDER_ERROR`。

**失败预算就是限流信号。** 质询页、限流、传输失败都与真正的空查询可区分：空查询返回空结果，限流抛出结构化错误，而同类失败连续重复 `failureThreshold` 次后，提供方在 `cooldownMs` 内不再自荐，让 seam 绕开它。任何成功——包括真正的空结果——都会清零计数；冷却期满后提供方带着全新的预算回来，而不是保持跳闸。

提供方**内部没有静默回退**：它自己绝不替换为另一个引擎。绕开冷却中的提供方是 seam 的选择工作，且只对未固定 `ddg` 的部署发生。固定的部署得到的是结构化错误——固定是「每次失败都要听见」的自觉选择。

## 版本兼容性

本包声明支持携带 `@deepseek-ai/dsh-web` `^0.2.0-rc.1 || ^0.2.1-alpha.1` 与 `@deepseek-ai/cordis` `~4.0.4 || ~4.0.5-alpha.1` 的 dsh 发布。dsh 在任何插件代码加载前就读取该范围，运行时不满足时跳过本捆绑包，所以这个声明同时是一道硬门禁。

| dsh 发布 | 验证内容 |
| --- | --- |
| `0.2.0-rc.1` | 完整路径：通过 `dsh plugin add` 装进真实 profile、启动、并回答真实查询 |
| `0.2.0-rc.2` | 契约套件（typecheck + 42 个离线测试）对该 seam，经 `pnpm compat` |
| `0.2.1-alpha.1` | 契约套件（typecheck + 42 个离线测试）对该 seam，经 `pnpm compat` |

semver 的预发布规则带来两个影响，直接决定了声明长什么样：

- caret 范围只有在某个比较器于同一 `[major, minor, patch]` 元组上携带预发布时才匹配预发布版本，所以 `^0.2.0-rc.1` 覆盖 `0.2.0-rc.2` 却不覆盖 `0.2.1-alpha.1`——后者需要自己的子句。
- 同一条规则拆开了 cordis：`~4.0.4` 匹配不了 0.2.1-alpha seam 携带的 `4.0.5-alpha.1`，所以 cordis peer 带上了并行的子句，而不是留下一个无声的失配。

0.1.x 的 seam 线**不在声明之列**，这是有意的。提供方契约本身对它们仍然通过（`pnpm compat` 以 0.1.5-rc.3 和 0.1.7-rc.2 作金丝雀跑同一套套件），但本捆绑包的 patch 路径——覆盖 base `web` 行——依赖的 loader 行为在那条线上有 bug（`duplicate loader entry id: web`，dsh 0.1.4 修复），且没有任何 0.1.x profile 的启动被端到端验证过。

`package.json` 还把声明的发布记录在 `dsh.compatibility.dshReleases` 里——面向插件目录的编目元数据；运行时不读它。放宽任何声明前，先重新验证并扩展上表：`pnpm compat`（需要 bash）在一次性项目里安装每条 seam 版本、跑同一套契约套件，并报告该版本是否落在声明的范围内。

## 实现

三条有意的规则：

- **引用目的地而非跳转**——解码 `uddg` 让模型与 UI 指向真实页面，且不产生额外请求。
- **绝不臆造字段**——空标题会丢弃该行，空白 snippet 会被省略而非置空，因此 seam 从不呈现捏造的值。
- **没有静默回退**——选择权始终属于 seam，本包从不替换为另一个引擎。

流程：`search()` 把 `q=` 追加到配置的 endpoint，以桌面版 Chrome user agent 和 `redirect: 'follow'` 发起 GET，并把调用方的 `AbortSignal` 转发给 fetch。正文用 Cheerio 解析——行位于 `#links .result` 下，标题取 `a.result__a`，摘要取 `a.result__snippet`——并在解析时施加可选的行数上限作为成本优化。存活行被规范化、按 URL 去重并保持页面顺序，然后返回；途中任何失败都按「可否重试」分类，并据此消耗——或不消耗——上文所述的失败预算。

| 文件 | 角色 |
| --- | --- |
| `src/index.ts` | 插件入口：配置 schema、提供方注册 |
| `src/provider.ts` | `DdgSearchProvider`：请求分发、中止分类、失败预算、行解析、重定向解码、结果映射 |
| `src/types.ts` | 抓取行词汇：`DdgScrapeEntry` |
| `cordis.patch.yml` | 本捆绑包的配置层，由 loader 应用 |

## 已知限制

这些限制说明本提供方何时是差劲选择。

- **异常检测基于签名**——只有「HTTP 202 且无 `#links .result` 行」这一签名才算限流并触发失败预算。若质询页以 HTTP 200 下发且没有行，仍会解析为零条来源，读起来像真正的空查询。
- **提供方内部不重试**——单次瞬态失败会以结构化错误呈现给调用方；只有重复发生（预算）才让提供方让位。是否重试一次失败的查询由调用方决定。
- **抓取标记脆弱**——上游选择器在 HTTP 200 页面上的漂移会降级为空结果而非结构化失败，所以标记变更看起来像一次糟糕的查询。
- **标题为空或 URL 不可用的行被丢弃**——没有可映射的可移植值，因此返回的条数可能少于请求数量。
- **`truncated` 永远不是 `true`**——本提供方把解析截断到 `request.maxResults`（或配置默认值），所以 seam 永远看不到过量返回，也永远不会翻转该标志。调用方无法得知页面实际存在更多结果；如需知晓，请请求更多条数。
- **`uddg` 重定向只解码一层**——若解码后的目标本身又是 DDG 跳转，会原样返回，因此双层嵌套的跳转呈现的是中间 URL 而非最终页面。
- **无 `publishedAt`，无 `content`**——静态标记两者都不携带，因此无法按发布日期过滤，也没有提供方答案；带密钥的后端是提供这些能力的。
- **查询塑形未暴露**——地区、safesearch、时间与类型过滤、翻页目前还没有提供方中立的 service 字段可挂载；配置面覆盖 `endpoint`、`maxResults` 与失败预算旋钮。
- **中止分类基于错误形状**——只有名为 `AbortError` 的 `DOMException`，或已中止的信号，会映射为 `WEB_ABORTED`；携带自定义 reason 的中止会呈现为 `WEB_PROVIDER_ERROR`。
- **未认证抓取带有服务条款风险**——高并发部署应使用有授权或第一方的后端。

## 开发

运行需要 Node ≥ 22；测试脚本使用 Node 原生 TypeScript 支持（无打包器，完全进程内），因此需要开启类型剥离（≥ 22.18），并通过 `--experimental-test-isolation=none`（≥ 22.8；不带 `experimental-` 前缀的写法只在 Node 24+ 存在）把所有文件跑在同一个进程里——推荐 Node 24。

```bash
pnpm install
pnpm test          # 单元 + 集成，离线（fetch 被 stub）；42 个测试
DDG_E2E=1 pnpm test:e2e   # 真实网络 smoke；未设标志时自跳过
pnpm typecheck
pnpm peers check   # 针对已安装 seam 线的 peer 范围自检
pnpm compat        # seam 版本矩阵；需要 bash 与 registry 访问
pnpm build         # 通过 tsc 产出 lib/
```

CI 在每次 push 与 pull request 上运行同一套离线检查（`typecheck`、`test`、`peers check`、`build`），并在重新构建使已提交的 `lib/` 与 `src/` 产生差异时失败，因此过期的预构建产物不可能落进 `main`。

集成测试把真实插件挂载进真实的 `@deepseek-ai/cordis` `Context`，使用真实的 `@deepseek-ai/dsh-web` `WebRuntime`，只 stub `globalThis.fetch`，并同时断言成功选择与 HMR 安全的反注册。dev 依赖固定被测的那条 seam 线：`@deepseek-ai/dsh-web@0.2.0-rc.1` 配 `@deepseek-ai/cordis ~4.0.4` 与 `@deepseek-ai/schemastery ~3.18.4`，与 dsh 0.2.0-rc.1 发布所带一致（见开发备注中关于 dsh peer 范围的一节）。`lib/` 已纳入版本控制，因此本地路径安装永远无需构建；重新打包 tarball 前请运行 `pnpm build`。

## 开发备注

面向维护者的工作上下文。不具权威性——已发布行为见上文各节。

### 捆绑包提供方 vs. 同族形态

已发布的 web 提供方（`web-search-exa`、`web-search-deepseek`、`web-search-perplexity`）是普通提供方包，由组合用显式行挂载。本包则发布 `dsh.bundle` patch，使 `dsh plugin add` 一条命令即可切换搜索后端，代价是成为唯一会覆盖 base `web` 行的提供方。转为同族形态意味着删掉 `dsh.bundle` 声明与 `cordis.patch.yml`，然后让每个部署自行挂载提供方行并固定 `searchProvider`。

### 显式解除固定后的歧义

`dsh-base` 已挂载 `web-search-deepseek`，所以安装本包会注册两个可用的搜索后端。本包固定了 `searchProvider: ddg`，因此避开 `WEB_PROVIDER_AMBIGUOUS`；但用空 `config` 覆盖 `web` 行的部署会移除该固定，从而撞上歧义错误。

### dsh peer 范围与兼容性门禁

`@deepseek-ai/dsh-web` 是 peer，因为 seam——它的 `WebRuntime` 服务与词汇表——归宿主所有，而非本包。在任何插件代码加载之前，dsh 会读取本清单的 peer 范围，并在运行时不满足该范围时跳过此捆绑包（`packages/boot/app-boot` 中的 `evaluatePluginCompatibility`），所以即使代码仍与 seam 匹配，过期的范围也会让捆绑包失效。门禁只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer，拿运行时的精确版本比对，并在范围中纳入预发布——`cordis` peer 不受门禁管辖。

该范围覆盖本提供方已验证的 0.2.x seam 线：dsh-web 为 `^0.2.0-rc.1 || ^0.2.1-alpha.1`，cordis 为 `~4.0.4 || ~4.0.5-alpha.1`。它所依赖的提供方契约——`WebSearchProvider`（`id` / `available()` / `search()`）、`WebSearchRequest` / `WebSearchResult` / `WebSearchSource` 词汇表、`WebError` 与 `ctx.web.registerSearchProvider`——在这些线之间没有变化，`pnpm compat` 按发布逐条证明：它在一次性项目里装上该 seam 版本与那条线自己想要的 cordis，跑 typecheck 加离线套件，并用 `pnpm peers check` 对照声明范围检查打包出的 tarball（这是唯一可靠的 oracle——`pnpm add` 只警告不失败，且 `--config.strict-peer-dependencies` 在 `add` 上不受尊重）。dev 依赖固定被测的那条线，因此改动 peer 范围后运行 `pnpm install` 才能让本地 seam 副本保持诚实。

0.1.x 线被有意排除。它们的 seam 契约仍然通过（矩阵以 0.1.5-rc.3 和 0.1.7-rc.2 作金丝雀跑套件），但本捆绑包的行覆盖依赖的 loader 行为在那条线上有 bug——重定义 base `web` 行直到 dsh 0.1.4 都会产生 `duplicate loader entry id: web`——且没有任何 0.1.x profile 启动被验证过，声明会超出证据。

`schemastery` 是**依赖**而非 peer，其范围必须跟随 seam 自己的 `schemastery` 依赖而不能滞后。每个 schemastery 副本都会合并同一个全局 `Schemastery` 命名空间，所以当 seam 的 0.2.0 副本声明带 volatile 模式的三参数 `Schema`、而本包的副本仍是两参数时，`pnpm typecheck` 会在 `exactOptionalPropertyTypes` 下于 `src/index.ts` 的 `Config` 模式上失败——尽管那一行并没有导入 seam。`~3.18.4` 与 cordis 的 `~4.0.4` 是 0.2.0-rc.1 这条线自身的固定；0.2.1-alpha 线携带 `~3.18.5-alpha.1` schemastery（它自己的副本经全局注册表共存）与 `~4.0.5-alpha.1` cordis，这正是 cordis peer 带并行子句的原因——`~4.0.4` 在 semver 上匹配不了 `4.0.5-alpha.1`。`pnpm peers check` 应当报告没有问题。

当 seam 发布新的一条线时：先针对它验证（`pnpm compat <version>`），再放宽范围，更新 `dsh.compatibility.dshReleases`，最后才提升本包的版本。若必须接受某个范围而又不想改声明，权宜之计是精确版本豁免：`dsh plugin --profile web allow-version dsh-web-search-ddg@<version> --dsh-version <runtime> --accept-risk`——它只为某一对插件/运行时授权，而不是修正声明。

### out-of-tree 安装中的重复模块副本

out-of-tree 捆绑包从 profile 的 `node_modules` 解析自己的导入，因此插件会拥有 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-web` 的独立副本，与宿主的 vendored 副本并存。两种重复都不会破坏功能，但原因不同，值得了解：

- `schemastery` 用 `Symbol.for("schemastery")` —— 全局注册表符号 —— 为其对象打上品牌，所以由 profile 副本构建的 `Config` schema 仍会被宿主的副本识别为 schemastery schema。
- `WebError` 是 runtime 导入（本提供方会抛出它），因此存在两个类对象。目前没有任何地方用 `instanceof` 消费它——seam 与 `dsh-tool-web` 按字符串 `code` 路由——所以这个分裂今天是惰性的。若将来有消费者做 `instanceof` 检查，它会失效；真要关心的话，改为抛出 seam 自己的错误而不是自行构造即可闭合。

## License

[MIT](LICENSE)
