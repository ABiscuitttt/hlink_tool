# hlink_tool

文件硬链接管理 Web 工具：双面板界面浏览源目录与目标目录，选中文件后通过 WebSocket 实时创建硬链接。

## 功能

- 双面板文件浏览（源目录 / 目标目录）
- WebSocket 实时创建硬链接（结构化 JSON 进度帧 + 完成统计）
- 文件硬链接数（nlink）徽标显示
- 中文界面
- 通过 `ALLOWED_ROOTS` 环境变量限制可浏览的根目录（逗号分隔，REST 与 WebSocket 均生效）
- 通过 `ALLOWED_ORIGINS` 环境变量配置 CORS 允许来源（逗号分隔，默认 `*`）
- Docker 一键部署（Nginx + FastAPI）

## 技术栈

- **后端**：Python FastAPI（uv 管理依赖）
- **前端**：原生 HTML/CSS/JS，无框架
- **部署**：Docker（Alpine Linux）+ Nginx 反向代理

## 快速开始

### 本地开发

```bash
uv sync
source .venv/bin/activate
fastapi dev main.py
```

### Docker

```bash
docker build -t hlink_tool .
docker run -p 8080:80 -v /data:/data -e DEFAULT_DIR=/data hlink_tool
```

打包发布：`bash scripts/buildtar.sh` → `hlink_tool.tar.gz`

## 说明

- **仅 Linux**：使用 `os.link()` 创建硬链接，不支持 Windows/macOS
- **无数据库**：所有操作直接作用于文件系统
- 日志输出到 `app.log`（100KB 轮转，保留 3 个备份）
- 架构与开发约定详见 [AGENTS.md](AGENTS.md)
