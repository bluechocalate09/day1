# Day1

<p align="center">
  <img src="docs/assets/day1-github-hero.png" alt="Day1 — 看清下一步，安静地继续" width="100%">
</p>

<p align="center">
  <strong>把长期方向拆成阶段，把今天收束成一件清楚的事。</strong><br>
  <sub>一个安静、清晰、以行动为中心的个人成长工作台。</sub>
</p>

<p align="center">
  <code>Python 3.11+</code> · <code>Flask</code> · <code>SQLite</code> · <code>原生前端</code>
</p>

## Day1 是什么

Day1 帮你把宏观方向变成每天可执行的一步：先写下长期目标，再拆成有权重的阶段与子目标，最后把当前下一步安排到今天。它也保留每日任务、进度证据、次日补充和年度记录，让计划与真实行动保持在同一条时间线上。

界面遵循简洁、克制和低干扰原则。Day1 小精灵会在公开与访客视图中陪伴记录，但不会抢走任务本身的注意力。

## 本次更新 · 目标阶段路线

> 2026-07-29 · 长期方向 → 阶段路线 → 子目标 → 今日行动

- 首页顶部新增长期方向横幅：同时显示短描述、总进度、当前阶段和下一项子目标。
- 每个阶段可分配独立权重；只有阶段完成后，权重才计入长期目标进度，未规划部分会明确保留。
- 阶段内部按子目标完成数量显示进度，长期成果与阶段过程分开表达。
- 目标路线集中在右侧侧栏；桌面保持轻窄，手机使用近全宽侧拉层。
- “安排到今天”会把下一项子目标预填到今日任务，不覆盖已经存在的内容。
- 访客可以只读查看目标路线，不能修改管理端记录。

完整变化与部署状态见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 长期方向 | 加权阶段、阶段子目标、阶段证明、用时与年度标记 |
| 今日行动 | 每日任务、完成度、最终结果、公开备注与北京时间跨日锁定 |
| 过程记录 | 多次追加进度、证据链接、图片与小文件附件、次日补充 |
| 专注与复盘 | 番茄钟、私密便签、分心记录与年度完成视图 |
| 多端协作 | 邀请制管理端、隔离空间、访客识别码、多端切换与留言回复 |
| 安全边界 | CSRF、安全响应头、登录限流、附件校验、内容去重与轻量备份 |

## 从方向到今天

```text
长期方向
├─ 阶段 1（权重）
│  ├─ 子目标
│  └─ 子目标 → 安排到今天
├─ 阶段 2（权重）
└─ 待规划空间
```

长期进度只累计已经完成的阶段权重；当前阶段的内部进度单独显示。这样既能看到终点，也不会把“正在做”误认为“已经做到”。

## 技术与目录

- Python、Flask、SQLite、Pillow
- 原生 HTML、CSS、JavaScript
- Gunicorn、Nginx、systemd

| 路径 | 说明 |
| --- | --- |
| `app/` | Flask 应用、数据库迁移与前端静态文件 |
| `tests/` | 后端、安全、权限与跨日行为的集成测试 |
| `deploy/` | VPS 服务、Nginx 与历史发布脚本 |
| `.github/workflows/` | 测试与 GitHub Release 自动化 |
| `docs/assets/` | GitHub 项目展示资源 |
| `RELEASE_NOTES.md` | 当前版本的完整更新说明 |

`deploy/` 中的脚本保留特定版本的历史路径。再次使用前，应先核对路径、域名、注册开关与备份策略。

## 本地运行

需要 Python 3.11 或更高版本。

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r app\requirements.txt
$env:DAILY_SEAL_DATA_DIR = "$PWD\.local-data"
$env:DAILY_SEAL_COOKIE_SECURE = "0"
$env:DAILY_SEAL_REGISTRATION_ENABLED = "1"
.\.venv\Scripts\python app\app.py --serve --port 8766
```

打开 `http://127.0.0.1:8766/`。本地数据保存在 `.local-data/`，不会进入 Git。

生产账号通过仓库外的一次性种子文件初始化；新管理端使用一次性邀请码注册，新访客使用管理端的预览识别码注册或连接。

运行数据按空间隔离：

```text
<data-dir>/
  daily-seal.db
  uploads/
  spaces/<随机键>/
    content.db
    uploads/
```

空间目录键完全由服务端生成。备份与恢复必须在服务停止后整体处理数据目录，不能只复制中央数据库。

## 发布与数据边界

推送到 `main` 后，GitHub Actions 会运行完整测试并检查 `RELEASE_NOTES.md`；全部通过后自动创建 GitHub Release。版本号使用 `v年.月.日.运行标识`。

仓库只保存程序代码和公开展示资源。数据库、账号、私人记录、附件、证书、服务器备份、种子文件与其他凭据必须始终留在仓库外。

## 设计参考

GitHub 首页的信息层级与展示节奏参考了 [makecindy/cindy](https://github.com/makecindy/cindy) 的公开仓库呈现方式；Day1 的文案、视觉、配色与小精灵画面均为项目原创。

## License

本项目当前未附带开源许可证。未经明确授权，不代表授予复制、修改或再分发权利。
