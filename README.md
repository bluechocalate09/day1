# Day1

<p align="center">
  <a href="https://day1.bluechocalate.localhost.cc/"><img src="docs/assets/day1-github-hero.png" alt="Day1 — 看清下一步，安静地继续" width="100%"></a>
</p>

<p align="center">
  <strong>把长期方向拆成阶段，把今天收束成一件清楚的事。</strong><br>
  <sub>一个安静、清晰、以行动为中心的个人成长工作台。</sub>
</p>

<p align="center">
  <code>Python 3.11+</code> · <code>Flask</code> · <code>SQLite</code> · <code>原生前端</code>
</p>

<p align="center">
  <a href="https://day1.bluechocalate.localhost.cc/">打开 Day1</a>
</p>

## Day1 是什么

Day1 帮你把宏观方向变成每天可执行的一步：先写下长期目标，再拆成有权重的阶段与子目标，最后把当前下一步安排到今天。它也保留每日任务、进度证据、次日补充和年度记录，让计划与真实行动保持在同一条时间线上。

界面遵循简洁、克制和低干扰原则。Day1 小精灵会在公开与访客视图中陪伴记录，但不会抢走任务本身的注意力。

## 本次更新 · 用勾选留下今天的进度

> 2026-10-01 · 先安排占比，完成后勾选，记录轻一点

每天的计划可以拆成一格一格的任务，为每项安排占比，合计 100%。点击“添加进度”，勾选已经完成的项目，Day1 就会按权重计算完成度；确认后“保存并收起”，也能避免随手误触。

文字、链接和附件仍然可以补充，但不必为每次进展重新写一段描述。最终结果也可以不写备注，北京时间 24:00 会按已保存的清单冻结当天结果。

- 已保存的勾选可以纠正；开始记录后，项目和占比保持固定，让历史完成度有一致的含义。
- 次日补充单独保留，不改写原结果；番茄数量可独立补录最近三个完整日期。
- 完成用绿色、未完成用琥珀色，冻结 0% 保留克制的警示；金色只表示阶段成果，长记录按需展开。

完整变化见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 长期方向 | 加权阶段、阶段子目标、阶段证明、用时与年度标记 |
| 今日行动 | 加权任务清单、勾选进度、可选结果备注与北京时间跨日锁定 |
| 过程记录 | 多次追加进度、证据链接、图片与小文件附件、次日补充 |
| 专注与复盘 | 番茄钟、三日番茄补录、私密便签、分心记录与年度完成视图 |
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

GitHub 首页的信息层级与展示节奏参考了 [makecindy/cindy](https://github.com/makecindy/cindy) 的公开仓库呈现方式；Day1 的产品文案、界面层级与配色均由项目独立整理。

## License

本项目当前未附带开源许可证。未经明确授权，不代表授予复制、修改或再分发权利。
