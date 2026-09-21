# 网图·IP管家（NetAtlas）

基于 Node.js、Express、SQLite 和 EJS 的 IP 地址管理系统，面向企业园区、学校及多部门网络环境，提供 IP 登记、网段规划、导入导出、统计分析、权限控制和审计追踪能力。

本系统可替代传统 Excel 台账，通过 VLAN 规划与网段映射实现 IP 地址的规范化分配与可用池范围校验，避免 IP 冲突和资源浪费。内置三级角色权限（超级管理员 / 管理员 / 普通用户），支持管理员按 VLAN 授权管理特定网段，满足多部门协同管理需求。所有关键操作均记录审计日志，确保可追溯。

## 技术栈

- **后端**：Node.js + Express
- **数据库**：SQLite（Node.js 内置 `node:sqlite`，单文件、零配置）
- **前端**：EJS 服务端渲染 + 原生 JavaScript（无前端框架依赖）
- **认证**：Session + bcrypt 密码哈希
- **安全**：CSP 内容安全策略、安全响应头、CSV 公式注入防护、服务端权限与输入校验、VLAN 权限默认拒绝
- **接口**：页面路由 + RESTful JSON API

## 主要功能

- **IP 全生命周期管理**：新增、查看、编辑、删除、搜索、筛选、排序和 CSV 导出
- **VLAN 与 IP 子网一致性校验**：IP 必须属于所选 VLAN 的子网，前后端双重校验
- **可用地址池硬校验**：VLAN 规划中配置可用地址范围（如 `.10–.200`）后，新增 / 编辑 / 导入时强制校验主机号落在池内（网关地址自动放行）
- **重复 IP 识别**：重复 IP 红色高亮标注，支持「只看重复 IP」筛选
- **MAC 冲突识别**：相同 MAC 地址在多条记录中出现时高亮，支持「只看 MAC 冲突」筛选
- **网段使用明细**：按网段前缀查看登记记录、已使用 / 可用数量、未登记主机号列表
- **数据字典维护**：设备类型、使用状态、所属部门、VLAN 规划、网关映射、系统配置
- **数据导入**：支持 Excel（`.xlsx`）和 CSV，自动映射常见中文列名，自动填充网关与 VLAN，重复 IP 支持「跳过 / 更新 / 报错」三种策略
- **数据导出**：CSV（UTF-8 BOM），按当前筛选条件导出全部结果，并对潜在公式注入内容进行转义
- **仪表板统计**：KPI 卡片（登记总数、已使用、预留/备用、已废弃、有 MAC、有向日葵 ID、重复 IP、MAC 冲突、使用中 VLAN 等）、VLAN 利用率进度条、部门与设备类型占比
- **三级角色权限**：超级管理员（全部权限）、管理员（仅授权 VLAN 可写）、普通用户（只读）
- **操作审计日志**：记录 IP、字典、用户、导入、系统配置等关键变更，支持按操作人、动作、对象类型、时间范围筛选
- **个人密码修改**：所有用户可验证旧密码后修改自身密码

## 环境要求

- **Node.js 22.5+**（需要支持 `node:sqlite` 与 `--experimental-sqlite`）
- npm

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录生成 Session 密钥：

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
```

可按需补充端口和运行环境：

```dotenv
PORT=3000
NODE_ENV=development
```

生产环境必须使用固定且高强度的 `SESSION_SECRET`，不要将 `.env` 提交到版本库。

### 3. 初始化数据库

```bash
npm run init-db
```

初始化脚本会创建 `db/ipam.db`，并写入基础字典、VLAN 规划、网关映射和默认超级管理员账号。

预置示例数据（可按实际环境修改）：

- 默认超级管理员：`admin` / `admin123`
- VLAN 规划示例：10 / 20 / 30 / 99（对应不同网段与名称）
- 设备类型、使用状态、所属部门基础条目
- IP 前缀 → 网关映射
- 系统配置（网站名称：网图·IP管家）

### 4. 启动服务

```bash
npm start
```

开发模式（文件变动自动重启）：

```bash
npm run dev
```

访问：<http://localhost:3000>

## 默认账号

| 用户名 | 密码     | 角色       |
|--------|----------|------------|
| `admin` | `admin123` | 超级管理员 |

**首次登录后必须立即修改密码。** 生产环境请在初始化后修改或禁用默认账号，并妥善保护数据库文件。

## 角色权限

| 功能                     | 超级管理员 | 管理员           | 普通用户 |
|--------------------------|:----------:|:----------------:|:--------:|
| 仪表板                   | 读写       | 只读             | 只读     |
| IP 登记台账              | 全部 VLAN  | 仅授权 VLAN 可写 | 只读     |
| 网段明细、查询、排序     | ✅         | ✅               | ✅       |
| 数据字典                 | 读写       | 只读             | 只读     |
| 用户管理                 | ✅         | ❌               | ❌       |
| 审计日志                 | ✅         | ❌               | ❌       |
| 系统配置                 | ✅         | ❌               | ❌       |
| 数据导入                 | ✅         | ✅（授权 VLAN）  | ❌       |
| CSV 导出                 | ✅         | ✅               | ✅       |
| 修改自身密码             | ✅         | ✅               | ✅       |

管理员通过「用户管理 → VLAN 权限」被授权后，才能对对应 VLAN 的 IP 记录进行新增、编辑、删除和导入。

## 使用说明摘要

### IP 登记

新增或编辑记录时，系统会校验：

- IP 地址格式
- IP 是否属于所选 VLAN 的子网
- IP 是否位于 VLAN 配置的可用地址范围（网关地址自动放行）
- 字典字段是否有效
- 当前用户是否有对应 VLAN 权限
- 是否存在重复 IP（提示但不强制阻断）

输入 IP 后可根据前缀自动匹配网关和 VLAN。管理员只能操作已授权 VLAN，普通用户只能查看和导出。

记录支持字段包括：IP 地址、MAC 地址、设备名称、设备类型、部门、使用人、位置、使用状态、VLAN、网关、上层交换机、交换机端口、向日葵 ID、登记日期、备注等。

### VLAN 与网段

VLAN 规划可配置 VLAN 编号、名称、网段（CIDR）、掩码、网关、描述和可用地址范围说明（如 `.10–.200`）。系统据此计算容量、利用率和剩余主机号；网关地址不计入可用数。

### 导入与导出

- 导入支持 Excel 和 CSV，系统可识别常见中文列名，并自动填充网关、VLAN 和默认状态。
- 重复 IP 可选择「跳过」「更新」或「报错」。
- 导入前会执行权限、字典值、IP/VLAN 一致性和地址池校验。
- 导出的 CSV 使用 UTF-8 BOM，并对潜在公式注入内容进行转义。
- 建议导入前备份数据库，尤其是选择「更新」策略时。

### 审计日志

超级管理员可按操作人、动作、对象类型和时间范围筛选日志。日志记录 IP、字典、用户、导入和系统配置等关键变更，业务界面不提供删除操作。

## API 概览

| 方法          | 路径                          | 说明               |
|---------------|-------------------------------|--------------------|
| POST          | `/login`                      | 登录               |
| POST          | `/logout`                     | 退出               |
| GET           | `/api/stats`                  | 仪表板统计         |
| GET           | `/api/records`                | IP 记录列表        |
| GET/POST/PUT/DELETE | `/api/records/:id`     | IP 记录操作        |
| GET           | `/api/subnet/:prefix`         | 网段明细           |
| GET           | `/api/gateway-lookup?ip=`     | 网关查询           |
| GET/POST/PUT/DELETE | `/api/dict/*`           | 字典读取与维护     |
| GET/POST/PUT/DELETE | `/api/users`            | 用户管理           |
| PUT           | `/api/users/:id/permissions`  | VLAN 权限授权      |
| POST          | `/api/users/:id/reset-password` | 重置密码         |
| POST          | `/api/change-password`        | 修改自身密码       |
| GET           | `/api/audit-logs`             | 审计日志           |
| GET           | `/api/export/records`         | 导出 IP 记录       |
| GET           | `/api/export/subnet/:prefix`  | 导出网段记录       |
| POST          | `/api/import/excel`           | Excel 导入         |
| POST          | `/api/import/csv`             | CSV 导入           |
| GET/PUT       | `/api/settings/:key`          | 系统配置           |

## 项目结构

```text
├── index.js              # 应用入口
├── package.json
├── config/
│   └── site.js           # 默认站点名称等配置
├── db/
│   ├── index.js          # 数据库连接
│   ├── init.js           # 数据库初始化
│   ├── wrapper.js        # SQLite 封装
│   └── ipam.db           # SQLite 数据库文件（运行后生成）
├── middleware/
│   └── auth.js           # 认证和权限中间件
├── routes/               # 页面、认证、API、导入路由
├── services/             # IP、字典、用户业务逻辑
├── views/                # EJS 页面模板
└── public/               # CSS、前端脚本和静态资源
```

## 部署

直接运行：

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
npm run init-db
npm start
```

使用 PM2：

```bash
npm install -g pm2
pm2 start index.js --name netatlas --node-args="--experimental-sqlite"
pm2 save
pm2 startup
```

环境变量：

| 变量             | 默认值 | 说明                                           |
|------------------|--------|------------------------------------------------|
| `PORT`           | `3000` | 服务端口                                       |
| `SESSION_SECRET` | 无固定值 | Session 密钥，生产环境必须配置固定高强度密钥 |
| `NODE_ENV`       | 空     | 设为 `production` 时启用安全 Cookie 属性       |

## 安全建议

- 使用 `openssl rand -hex 32` 生成高强度 Session 密钥，并写入项目根目录 `.env`。
- 首次登录后立即修改默认超级管理员密码。
- `.env`、`db/ipam.db` 和备份文件应限制文件系统权限，不要提交到 Git 或公开目录。
- 生产环境通过 HTTPS 暴露服务，并设置反向代理访问控制。
- 定期备份 SQLite 数据库（`db/ipam.db`），备份文件应加密并测试恢复流程。
- 导入不可信文件前先确认来源，并控制文件大小和批量规模。
- 仅授予管理员完成工作所需的 VLAN 权限。
- 定期审查用户账号、管理员 VLAN 权限和审计日志。
- 变更 VLAN 规划、网关映射前先确认对现有 IP 记录和导入流程的影响。

## 常用命令

```bash
npm install       # 安装依赖
npm run init-db   # 初始化数据库
npm start         # 启动生产模式
npm run dev       # 启动开发模式（文件变动自动重启）
npm run build     # 执行项目构建检查（当前无实际构建步骤）
```

## 许可

本项目为内部 IP 地址管理系统，具体使用、分发和修改范围以项目所有者的授权为准。
