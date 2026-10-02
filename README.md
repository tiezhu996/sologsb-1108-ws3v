# 胶片冲洗参数库

面向黑白与彩色胶片冲洗者的本地参数管理工具。可以按乳剂批次登记胶片、记录显影液工作液寿命、编排冲洗配方，并把每次实冲温度、时间和样片结果沉淀为下一批次的修正依据。应用为纯前端单页应用，不需要后端服务或外部接口。

## Docker 一键启动

在项目根目录执行：

```bash
cp .env.example .env && docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 5 |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 本地数据 | Dexie 4 + IndexedDB |
| 容器 | Nginx Alpine + Docker Compose |

## 访问地址

浏览器打开：`http://localhost:21808`

如修改 `.env` 中的 `FRONTEND_PORT`，请使用修改后的端口。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

开发服务器默认地址为 `http://localhost:5173`。生产构建检查使用：

```bash
cd frontend
npm run build
```

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── README.md
└── frontend
    ├── Dockerfile
    ├── nginx.conf
    └── src
        ├── components/common   # 曲线、稀释、推拉标签与筛选组件
        ├── hooks               # 配方筛选与温度补偿
        ├── pages               # 五个业务页面
        ├── router              # 路由配置
        ├── stores              # 四类数据的 Pinia 状态与持久化动作
        ├── types               # 胶片、显影液、配方、冲洗记录模型
        └── utils               # Dexie 数据层、比例换算、JSON 导出
```

## 数据存储说明

- IndexedDB 数据库名：`gbfilmdev-db`
- Dexie 版本：`version(1)` 创建 `films`、`developers`、`recipes`、`runs` 四张表并建立常用查询索引。
- 迁移：`version(2).upgrade(...)` 为已有记录回填 `schemaRev: 2`。`version(3)` 增加冲洗机回传对账能力：
  - `developers` 增加 `batchNo`（工作液批号，旧数据回填 `WB-LEGACY-xxx`）、`lastActivity`（旧数据留空，不补造数值）。
  - `runs` 增加 `verifiedBy`（旧记录一律标记为 `manual` 手工校验）、`readingId`、`developerId`、`basisSnapshot`。
  - 新增 `readings`（冲洗机控制条读数，`callbackId` 唯一索引保证重试幂等）、`baselineConflicts`（配方基准两版并列）、`corrections`（本机修正建议及生命周期）三张表。
- 首次打开数据库时通过 `populate` 写入丰富的胶片、显影液、配方和实冲记录。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份（备份含回传读数、基准冲突与修正建议）。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。

## 冲洗机回传对账规则

外部暗房冲洗机只回传**事实**（活性、温度、时长）与机器侧配方基准；配方建议始终由本机按配方与工作液活性重算。

- **对账**：回传按工作液批号（`solutionBatchNo`）与实冲批次号（`runBatchNo`）匹配本地台账；匹配不上为“未对上账”，本地实冲属于另一支工作液为“批号冲突”，二者都不采纳活性。补录工作液/实冲后可一键或自动重新对账。
- **幂等**：以 `callbackId` 为唯一键，同一报文重复投递只累加投递次数，绝不多出读数、不重放活性更新；幂等判断先于报文内容校验。
- **基准冲突**：回传的配方基准（温度/时长）与本机配方不一致时，机器版与本机版并列保留，待人工选定；选定前**整批工作液冻结**，不生成任何新建议。活性事实仍照常留档。
- **建议生命周期**：活性事实更新（更晚的测量时间）时，所有未采纳（pending）建议立即作废（void）并按新活性重算；已采纳（applied）的建议及其实冲判定依据快照永久保留，不再变动。更早测量时间的迟到读数只留事实，不回退活性。
- **旧记录**：没有仪器读数的历史实冲一律标为“手工校验”，不补造任何活性、温度或时长数值；读数晚到并对上账后只补挂读数来源，实冲数值原样保留。
- **边界**：回传适配层按白名单取字段，报文若夹带建议类字段会被直接丢弃；数值超出合理区间或缺少必填字段的报文整体拒收。
- 规则验证脚本：`cd frontend && npm run verify`（基于 fake-indexeddb，覆盖对账、幂等、失效重算、冲突冻结、已采纳冻结等 58 项断言）。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，观察余量 |
| `/developers` | 显影液配制与余量 | 登记工作液、换算容量、查看剩余可冲卷数并标记报废 |
| `/recipes` | 配方表 | 编排配方，按胶片和稀释比筛选，改温度即时重算时间 |
| `/runs` | 冲洗记录与结果评价 | 录入实冲温度与时间，查看补偿建议并回写配方注释 |
| `/inbox` | 冲洗机回传对账 | 接收外部冲洗机 JSON 回传，按工作液批号/实冲批次对账，处理基准冲突与本机建议 |

未匹配的路由会重定向到 `/`。
