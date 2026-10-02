# 胶片冲洗参数库

面向黑白与彩色胶片冲洗者的本地参数管理工具。可以按乳剂批次登记胶片、记录显影液工作液寿命、编排冲洗配方，并把每次实冲温度、时间和样片结果沉淀为下一批次的修正依据。应用为纯前端单页应用，不需要后端服务；暗房冲洗机（外部系统）的控制条回传在“回传对账”页手工录入入账，不依赖实时接口。

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
        ├── pages               # 六个业务页面
        ├── router              # 路由配置
        ├── stores              # 五类数据的 Pinia 状态与持久化动作
        ├── types               # 胶片、显影液、配方、冲洗记录与回传读数模型
        └── utils               # Dexie 数据层、比例换算、建议重算、JSON 导出
```

## 数据存储说明

- IndexedDB 数据库名：`gbfilmdev-db`
- Dexie 版本：`version(1)` 创建 `films`、`developers`、`recipes`、`runs` 四张表并建立常用查询索引。
- 迁移：`version(2).upgrade(...)` 为已有记录回填 `schemaRev: 2`；`version(3).upgrade(...)` 新增 `readings`、`conflicts`、`advices` 三张表，为显影液补 `batchNo` 字段（旧记录留空待人工补登），为旧冲洗记录标记 `readingSource: 'manual'`（手工校验，不补造仪器数值）。首次打开数据库时通过 `populate` 写入丰富的胶片、显影液、配方、实冲记录与示例回传数据。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。

## 冲洗机回传对账规则

- 冲洗机只提供活性、温度、时长与机侧配方基准四类事实；配方修正建议始终由本机按配方基准与工作液活性重算（温度补偿 × 活性倒数）。
- 每条回传按**工作液批号**（显影液台账 `batchNo`）与**实冲批次**（冲洗记录 `batchNo`）对账；对不上的读数挂起并标注原因，批号可在显影液台账补登。
- 回传单号（`reportId`）有唯一索引，同一回传重试不会重复入账，也不会重复触发建议重算。
- 回传的配方基准若与本机配方不一致，两版并列保留；人工选定（本机版 / 冲洗机版）之前，该批工作液不参与新建议，其未完成建议先行失效。
- 活性更新后，该工作液所有未完成的修正建议立即失效并按最新读数重算；已采纳的建议与已完成实冲记录的判定依据照旧保留，不回改。
- 没有仪器读数的旧冲洗记录一律标记为“手工校验”，只挂接事实、不补造数值。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，观察余量 |
| `/developers` | 显影液配制与余量 | 登记工作液与批号、换算容量、查看剩余可冲卷数并标记报废 |
| `/recipes` | 配方表 | 编排配方，按胶片和稀释比筛选，改温度即时重算时间 |
| `/runs` | 冲洗记录与结果评价 | 录入实冲温度与时间，查看补偿建议并回写配方注释 |
| `/readings` | 冲洗机回传对账 | 接收回传读数，按批号与实冲批次对账，并列基准冲突并重算修正建议 |

未匹配的路由会重定向到 `/`。
