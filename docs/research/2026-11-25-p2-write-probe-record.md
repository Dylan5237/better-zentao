# P2 写能力验证记录

2026-11-25，禅道开源版 22.6，`URAndSR: true`。探查只使用受控产品 #29，读回模块 `564`、未关闭 L3 计划 `771`、多迭代项目 `314`（`multiple: 1`）与未关闭执行 `315`（`2026-11-25` 至 `2026-12-31`，关联产品 `[29]`）。

## 只读前置与兼容发现

- `GET /api.php/v1/products/29/projects` 在 22.6 实测缺失 `multiple`、`deleted` 与 `products`；`GET /api.php/v1/projects/314` 亦缺失 `products`。发送层改用 `GET /api.php/v2/project/view?projectID=314` 校验归属与多迭代标记（`546f0966`）。
- 关联需求后，`GET /api.php/v1/stories/{id}` 可能返回 `requirements: [{}]` 空占位，`GET /api.php/v2/story/view` 返回分组对象 `relations: { story: { "<id>": ... } }`，已在需求 DTO 与探查回读校验兼容（`c587e893`）。
- 全部 11 个产品上的 `GET /api.php/v1/products/{id}/releases` 均返回 HTTP 200 与空列表 `[]`，尚未取得非空发布对象样本。

## P2 能力实测结果

| 能力 | 实测端点与 HTTP 状态 | 回读与行为观察 | 22.6 注册状态 |
| --- | --- | --- | --- |
| `story.edit` | `PUT /api.php/v1/stories/4873`，200 | 发送 `{ title, keywords, plan: 771 }`，回读确认 `plan="771"`、`stage="planned"` 且原 `spec`（含 `[bzt:v1 ...]` 标签）完整保留。此前探查确认该 PUT 端点忽略请求中的 `spec` 正文修改（需未验证的 `story/change`）。 | `verified`（关键词与计划；正文编辑不在此配方） |
| `story.create.plan` | `POST /api.php/v2/stories?productID=29`，200 | `#4874` 创建时直接传 `plan` 被服务端静默忽略，回读 `plan` 仍为空。创建后挂接计划需走 `story.edit`。 | `unverified` |
| `story.linkStory` | `POST /api.php/v2/story/linkStory?storyID=4879`，200 | 对研发需求 `#4879` 与设计需求 `#4880` 互链，`GET /api.php/v2/story/view` 的 `relations.story` 双向回读一致（`v1/stories/{id}` 的 `linkStories` 保持空串）。 | 新增 `verified` |
| `story.linkExecution` | `POST /api.php/v1/executions/315/stories`，200（无效果）；`POST /api.php/v2/execution/linkStory?objectID=315`，200 | v1 路径仅作只读列表返回，不产生关联；草稿需求亦被拒绝。将 `#4884` 先经 `PUT v1/stories/4884`（`status="active"`）激活后，再调 v2 关联成功并回读确认。 | 新增 `verified`（v2，仅接受 `active` 需求） |
| `task.create` | `POST /api.php/v1/executions/315/tasks`，201 | 在 `#315` 下为 `#4884` 创建单级 L3 任务 `#4873`（`project=314`、`module=564`、`type="devel"`），回读一致。早前在 `#4872` 实测 `desc` 中的 `<!-- bzt:stage=dev -->` 注释被 22.6 清洗；改用可见微标签 `<p style="color:#999;font-size:12px">[bzt:stage=dev]</p>` 后回读完整留存。候选 L4 批量子任务 `POST /api.php/v2/task/batchCreate` 在 #29 实测返回 HTTP 200 `fail`（0 条落库），子任务配方仍待验证。 | 新增 `verified`（单级 L3 任务；L4 子任务待验） |
| `task.close` | `POST /api.php/v1/tasks/{id}/close`，200（无效果）；`POST /api.php/v2/task/cancel?taskID=4873`，200 → `POST /api.php/v2/task/close?taskID=4873`，200 | v1 关闭路由实测无写入效果，且 22.6 不允许直接关闭 `wait`/`doing` 任务。先调用 `v2/task/cancel` 转为 `cancel` 再调用 `v2/task/close` 后，回读确认 `#4873`（及 `#4872`）为 `closed`。 | 新增 `verified`（v2 close；未开始/进行中任务先 cancel） |
| `requirement.linkStory` | 未执行写入 | `#29` 下用户需求为 0，且实例开启 `forceReview: true` 拒绝当前测试账号经 `v2/requirement/create` 自建用户需求。 | `unverified` |
| `release.read` | `GET /api.php/v1/products/{id}/releases`，200 | 全部 11 个产品均为空列表，非空结构尚缺真实样本。 | `unverified` |

## 清理与夹具入库

- 独立回读确认本轮在 #29 新建的测试需求（`#4872`–`#4884`）与测试任务（`#4872`–`#4873`）全部为 `status="closed"`，#29 无遗留未关闭测试对象；#29 之外业务写入 0 次，删除 0 次。
- 新增 [6 份脱敏写入夹具](../../test/fixtures/zentao-22.6/writes/) 已纳入仓库并通过 S01、敏感信息扫描与契约测试：
  - `story-edit.4873.json`
  - `story-linkStory.4880.json`
  - `story-linkExecution.4884.json`
  - `task-create.4873.json`
  - `task-cancel.4873.json`
  - `task-close.4873.json`
