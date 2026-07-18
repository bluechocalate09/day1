# Daily Seal

Daily Seal 是一个简洁的个人学习记录网站，用于安排每日任务、记录完成证明，并跟踪更长周期的阶段目标。

本仓库是 Day1 项目的代码存档。生产数据库、账号、私人便签、分心记录、上传附件、证书与服务器备份均不包含在仓库中。

## 功能

- 每日任务、完成 / 未完成反馈、完成程度、公开备注或未完成原因
- 完成证明、证据链接与附件
- 阶段目标、完成证明、用时记录与年度金色标记
- 番茄钟、公开完成记录、私密便签与分心记录
- 管理者可编辑，访客账号只读
- JPG、PNG、WebP、PDF、TXT、CSV、DOCX、XLSX、PPTX 附件，单个最大 10 MiB
- 桌面、iPad 与手机响应式界面
- JSON 迁移与备份、登录限流、CSRF 与安全响应头

## 技术栈

- Python、Flask、SQLite、Pillow
- 原生 HTML、CSS、JavaScript
- Gunicorn、Nginx、systemd

## 目录

```text
app/       Flask 应用与前端静态文件
deploy/    VPS 服务、Nginx 和历史发布脚本
tests/     后端与安全集成测试
```

`deploy/` 中部分脚本保留了特定版本的发布目录和备份路径，用于历史存档。再次使用前应先检查路径、域名和注册开关。

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

打开 `http://127.0.0.1:8766/`。本地数据会保存在 `.local-data/`，该目录不会进入 Git。

生产环境的管理者账号通过仓库外的一次性种子文件初始化；种子文件、密码和密码哈希都不应提交。

## 测试

安装依赖后运行：

```powershell
.\.venv\Scripts\python -m unittest discover -s tests -p "test_app.py" -v
```

当前存档版本包含 34 项集成测试，覆盖登录与权限、每日结果反馈、公开与私密字段隔离、阶段目标、导入导出、附件校验、大小边界、并发替换和孤立文件清理。

## 自动版本存档

每次代码推送到 `main` 分支后，GitHub Actions 会先运行完整集成测试；只有测试全部通过，才会自动创建 GitHub Release。版本号采用 `v年.月.日.运行标识`；Release 会保留该版本的源码压缩包和自动生成的更新说明。同一次更新即使重新运行，也不会重复创建版本。

自动发布配置位于 `.github/workflows/release.yml`。它不需要额外密钥或第三方服务，也不会消耗 Codex / ChatGPT 积分；运行测试和发布会使用 GitHub Actions 账户额度。

## 安全与数据

- 不要提交 `data/`、数据库、附件、备份、`.env`、证书、种子文件或任何登录凭据。
- 公开仓库前，应再次检查域名、历史发布脚本和界面截图。
- 若凭据曾被提交，仅从最新提交删除并不安全；应立即更换凭据并清理 Git 历史。

## 存档说明

初始存档对应 2026-07-18 的附件上传版本。仓库默认建议保持私有；本项目未附带开源许可证。
