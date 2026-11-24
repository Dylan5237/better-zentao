# P0 写能力验证记录

2026-11-24，禅道开源版 22.6，`URAndSR: true`。探查只使用产品 #29。读回可用模块 `564`，可用未关闭计划 0 个，挂载项目和执行均为 0。

## 只读门禁

- 离线 lint、类型检查和覆盖率门禁通过后才开始连接禅道。
- `bzt doctor --live` 通过，实例和认证检查成功，登录账号已遮盖。
- `pnpm test:smoke` 通过 3 组测试，覆盖 16 个只读接口。任务列表的业务 HTML 可含站内链接，测试不输出正文并继续扫描凭据。任务详情实测出现 `team: false`，按 06 Q6 投影为空团队，其余非法形态仍报错。

## HTML 注释试验

`POST /api.php/v2/stories?productID=29` 返回 HTTP 200 和需求 `#4849`。`GET /api.php/v1/stories/4849` 返回 HTTP 200，`<h3>/<p>/<ul>/<li>` 和正文换行通过比对，`spec` 未回读到 `<!-- bzt:v1 ... -->`。因此本次注释格式的创建结果记为 `unknown`，没有重发该创建请求。通过 `POST /api.php/v1/stories/4849/close` 返回 HTTP 200，再读确认 `status=closed`。

## 可见微标签试验及能力状态

使用 `--visible-tag` 开始独立探查，新建需求采用新的探查编号。三条需求回读均确认 `draft`、模块 `564`、标题、指派、无计划、HTML 段落与列表换行，以及 `[bzt:v1 ...]` 的角色字段。编辑关键词后也复核了该正文和标签。所有成功项均通过 `GET /api.php/v1/stories/{id}` 确认效果。

| 能力 | 实测端点与 HTTP 状态 | 回读结果 | 22.6 注册状态 |
| --- | --- | --- | --- |
| `story.create` | `POST /api.php/v2/stories?productID=29`，200 | `#4850` 草稿和可见微标签一致。注释试验见上 | `verified`，复验通过 |
| `story.assign` | `POST /api.php/v1/stories/4850/assign`，200 | 同值确认跳过，实际改派仅发一次请求，回读与目标一致 | `verified`，复验通过 |
| `story.comment` | `POST /api.php/v1/stories/4850/comment`，404；`POST /api.php/v2/action/comment?objectType=story&objectID=4850`，200 | 首选端点返回 404 后读回无评论，再试候选。动作列表读回本次评论 | 新增 `verified`（v2） |
| `story.edit` | `PUT /api.php/v1/stories/4850`，200 | 关键词一致，标题、正文和标签仍在。改计划或正文标签未验证 | 新增 `verified`（改关键词配方） |
| `story.activate` | `POST /api.php/v1/stories/4850/activate`，404；`PUT /api.php/v1/stories/4850`，200 | 404 后核对仍为 `draft`，再用 PUT 设为 `active` 并回读确认 | 新增 `verified`（PUT） |
| `story.close` | `POST /api.php/v1/stories/{id}/close`，4 次均为 200 | `closedReason=cancel`，四条均回读 `closed` | 新增 `verified` |
| `story.create.design` | `POST /api.php/v2/stories?productID=29`，200 | `#4851` 回读 `category=design` | 新增 `verified` |
| `story.create.feedbackBy` | `POST /api.php/v2/stories?productID=29`，200 | `#4852` 回读测试反馈者文本一致 | 新增 `verified` |
| `story.create.plan` | 未发送 | #29 无可用未关闭计划 | `unverified` |
| `task.create` | 未发送 | #29 无验证迭代 | `unverified` |
| `story.linkExecution` | 未发送 | #29 无验证迭代 | `unverified` |

## 清理与脱敏

- 独立复读确认 `#4849`、`#4850`、`#4851`、`#4852` 均属于产品 #29，状态均为 `closed`。
- 共 14 次 #29 业务写入请求，其中 2 次候选路由返回 404。#29 之外业务写入 0 次，删除 0 次。登录请求单独计为认证流量。
- [11 份写入夹具](../../test/fixtures/zentao-22.6/writes/)均保存实际 HTTP 状态码与脱敏请求、响应。落盘前通过带会话凭据的二次扫描，落盘后再次通过 S01 和 `assertSanitizedJson`。原有 39 份只读夹具保留原样。

## Web 富文本待核对项

API 回读能说明禅道接口返回的 HTML 和标签内容。页面渲染、KindEditor 手动编辑和二次保存后标签留存尚无人工证据。人工复验时只在 #29 使用专用测试需求，观察 HTML 段落与列表的渲染，保存后再通过详情接口检查可见微标签并关闭该需求。
