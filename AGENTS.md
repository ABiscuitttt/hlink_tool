# AGENTS.md — hlink_tool

文件硬链接管理 Web 工具。通过双面板界面浏览源目录和目标目录，选择文件后通过 WebSocket 实时创建硬链接。

## 技术栈

- **后端**: Python FastAPI（`fastapi[standard]`）
- **前端**: 原生 HTML/CSS/JS，无框架
- **部署**: Docker（Alpine Linux）+ Nginx 反向代理
- **打包**: `scripts/buildtar.sh` → `hlink_tool.tar.gz`

## 架构

```
浏览器 → Nginx (:80) → /api/* → FastAPI (uvicorn)
                      → /*      → 静态文件 /var/www/html
```

- FastAPI 设置了 `root_path="/api"`，所有路由自动带 `/api` 前缀
- Nginx 配置在 `nginx_conf/default.conf`，静态文件从 `html/` 复制到 `/var/www/html`
- 容器入口: `scripts/init.sh`（激活 venv → 启动 nginx → 启动 fastapi）

## 关键约定

- **仅 Linux**: 使用 `os.link()` 创建硬链接，不支持 Windows/macOS
- **无数据库**: 所有操作直接操作文件系统
- **无测试**: 当前项目不包含自动化测试
- **日志**: 使用 `logging.handlers.RotatingFileHandler`，输出到 `app.log`（100KB 轮转，保留 3 个备份）
- **中文 UI**: 前端界面为中文
- **路径安全**: 通过 `ALLOWED_ROOTS` 环境变量限制可浏览的根目录（逗号分隔），不设置则向后兼容不限制

## 常用命令

```bash
# 本地开发（uv 管理虚拟环境和依赖）
uv sync
source .venv/bin/activate
fastapi dev main.py

# 打包
bash scripts/buildtar.sh

# Docker 构建与运行
docker build -t hlink_tool .
docker run -p 8080:80 -v /data:/data -e DEFAULT_DIR=/data hlink_tool
```

## 项目结构

| 路径 | 用途 |
|------|------|
| `main.py` | FastAPI 后端，所有 API 路由和 WebSocket |
| `pyproject.toml` | 项目元数据与 uv 依赖管理（清华镜像源） |
| `html/index.html` | 前端页面结构 |
| `html/app.js` | 前端逻辑（文件列表、选择、链接操作） |
| `html/styles.css` | 前端样式 |
| `nginx_conf/default.conf` | Nginx 配置 |
| `scripts/buildtar.sh` | 打包脚本 |
| `scripts/init.sh` | 容器启动脚本 |
| `dockerfile` | Docker 镜像构建 |
