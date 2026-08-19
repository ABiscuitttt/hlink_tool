"""hlink-tool 后端服务。

基于 FastAPI 的文件硬链接管理 Web 工具（仅支持 Linux，使用 os.link() 创建硬链接）。
通过 Nginx 反向代理对外提供服务，root_path 为 /api。

路径安全：设置环境变量 ALLOWED_ROOTS（逗号分隔）后，所有文件操作路径
必须位于允许的根目录之内。
"""

import asyncio
import errno
import logging
import logging.handlers  # 显式导入，RotatingFileHandler 在此子模块中
import os
from collections.abc import AsyncGenerator
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(root_path="/api")

# CORS：从环境变量 ALLOWED_ORIGINS（逗号分隔）读取允许的来源。
# 缺省为 ["*"]，但 "*" 与 allow_credentials=True 是非法组合，此时关闭凭证。
_ALLOWED_ORIGINS_RAW = os.environ.get("ALLOWED_ORIGINS", "").strip()
_allow_origins = (
    [origin.strip() for origin in _ALLOWED_ORIGINS_RAW.split(",") if origin.strip()]
    if _ALLOWED_ORIGINS_RAW
    else ["*"]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("uvicorn")
handler = logging.handlers.RotatingFileHandler(
    "app.log", mode="a", maxBytes=100 * 1024, backupCount=3
)
handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logger.addHandler(handler)

# 路径安全：解析允许的根目录列表
_ALLOWED_ROOTS_RAW = os.environ.get("ALLOWED_ROOTS", "")
_ALLOWED_ROOTS = (
    [Path(p).resolve() for p in _ALLOWED_ROOTS_RAW.split(",") if p.strip()]
    if _ALLOWED_ROOTS_RAW.strip()
    else None  # None 表示不限制（向后兼容）
)


def _check_path(path: Path) -> Path:
    """验证并规范化路径，若设置了 ALLOWED_ROOTS 则检查路径是否在允许范围内。"""
    resolved = path.resolve()
    if not resolved.exists():
        raise HTTPException(status_code=400, detail=f"请求的路径不存在: {path}")
    if _ALLOWED_ROOTS is not None and not any(
        resolved.is_relative_to(root) for root in _ALLOWED_ROOTS
    ):
        raise HTTPException(status_code=403, detail=f"禁止访问此路径: {path}")
    return resolved


def _check_dir(path: Path) -> Path:
    """_check_path 基础上再校验路径是目录，否则 400。"""
    resolved = _check_path(path)
    if not resolved.is_dir():
        logger.warning("请求的路径不是目录: %s", resolved)
        raise HTTPException(status_code=400, detail=f"请求的路径不是目录: {resolved}")
    return resolved


class CreateDirRequest(BaseModel):
    """创建文件夹请求体。"""

    path: Path  # 父目录绝对路径
    name: str  # 新文件夹名称


@app.get("/list_dir")
def list_directory(path: Path, filter_single_link: bool = False) -> list[dict]:
    """列出目录内容，目录在前、文件在后，名称排序大小写不敏感。"""
    path = _check_dir(path)

    results = []
    for item in path.iterdir():
        try:
            stat_info = item.stat(follow_symlinks=False)
            if filter_single_link and not (
                (item.is_file() and stat_info.st_nlink == 1)
                or (item.is_dir() and contains_single_link_file(item))
            ):
                continue
            results.append(file_info(item, stat_info))
        except Exception as e:
            logger.error("处理项目 %s 时出错: %s", item, e)

    if path != path.parent:
        results.append(
            {
                "name": "..",
                "type": "directory",
                "path": path.parent.absolute().as_posix(),
                "size": "--",
                "isParent": True,
            }
        )

    results.sort(key=lambda item: (item["type"], item["name"].lower()))
    return results


@app.get("/dir_size")
def directory_size(path: Path) -> str:
    """统计目录总大小（跳过符号链接），整体异常时返回 "未知"。"""
    path = _check_dir(path)

    total_size = 0
    try:
        for item in path.rglob("*"):
            if item.is_file() and not item.is_symlink():
                try:
                    total_size += item.stat().st_size
                except Exception as e:
                    logger.error("获取文件大小时出错 %s: %s", item, e)
    except Exception as e:
        logger.error("遍历目录时出错 %s: %s", path, e)
        return "未知"

    return format_file_size(total_size)


@app.post("/create_dir")
def create_dir(req: CreateDirRequest) -> dict:
    """在指定目录下创建新文件夹。"""
    path = _check_path(req.path)
    new_folder_path = path / req.name

    if any(char in req.name for char in r'\/:*?"<>|'):
        raise HTTPException(status_code=400, detail="文件夹名称包含非法字符")

    try:
        new_folder_path.mkdir(parents=True, exist_ok=False)
        return {"message": "文件夹创建成功"}
    except FileExistsError:
        logger.warning("文件夹已存在: %s", new_folder_path)
        raise HTTPException(status_code=400, detail="文件夹已存在")  # noqa: B904
    except Exception as e:
        logger.error("创建文件夹时出错 %s: %s", new_folder_path, e)
        raise HTTPException(status_code=500, detail="创建文件夹失败")  # noqa: B904


@app.get("/default_dir")
def default_dir() -> dict:
    """返回默认目录（环境变量 DEFAULT_DIR，缺省 /data）。"""
    return {"dir": os.environ.get("DEFAULT_DIR", "/data")}


def _link_error_message(e: OSError) -> str:
    """将 os.link 的异常转换为友好的中文错误信息。"""
    if e.errno == errno.EXDEV:
        return "源文件与目标路径不在同一文件系统（跨设备），无法创建硬链接"
    if isinstance(e, PermissionError) or e.errno in (errno.EACCES, errno.EPERM):
        return "权限不足，无法创建硬链接"
    return f"创建硬链接失败: {e}"


async def _ws_send_error_and_close(websocket: WebSocket, message: str) -> None:
    """发送错误帧并优雅关闭 WebSocket 连接。"""
    try:
        await websocket.send_json({"type": "error", "message": message})
        await websocket.close()
    except Exception:
        logger.debug("发送错误消息或关闭连接失败，客户端可能已断开")


async def _ws_send_skip(
    websocket: WebSocket, stats: dict, message: str, source: Path
) -> None:
    """累计 skipped 计数并发送 skip 帧。"""
    stats["skipped"] += 1
    await websocket.send_json(
        {"type": "skip", "message": message, "source": source.as_posix()}
    )


@app.websocket("/ws/link_files")
async def websocket_progress(websocket: WebSocket) -> None:
    """通过 WebSocket 执行硬链接任务，持续发送结构化 JSON 帧。

    客户端首条消息格式：{"link": true, "src_files": [...], "dst_path": "..."}
    服务端发送 info/progress/skip/error/done 帧，done 为最后一条，随后关闭连接。
    """
    await websocket.accept()

    try:
        data = await websocket.receive_json()

        src_files_raw = data.get("src_files")
        dst_path_raw = data.get("dst_path")
        if (
            not isinstance(data, dict)
            or data.get("link") is not True
            or not isinstance(src_files_raw, list)
            or not src_files_raw
            or not dst_path_raw
        ):
            await _ws_send_error_and_close(
                websocket,
                "请求格式错误：需要 {'link': true, 'src_files': [...], 'dst_path': '...'}",
            )
            return

        # 路径安全：src_files 与 dst_path 都必须通过 ALLOWED_ROOTS 校验
        try:
            dst_path = _check_path(Path(dst_path_raw))
        except HTTPException as e:
            await _ws_send_error_and_close(websocket, str(e.detail))
            return

        src_files: list[Path] = []
        for src in src_files_raw:
            try:
                src_files.append(_check_path(Path(src)))
            except HTTPException as e:
                # 任一源路径违规即发送错误并关闭，不执行任何链接
                await _ws_send_error_and_close(websocket, str(e.detail))
                return

        if not dst_path.is_dir():
            await _ws_send_error_and_close(
                websocket, f"目标路径不是有效的目录: {dst_path}"
            )
            return

        total = len(src_files)
        stats = {"linked": 0, "failed": 0, "skipped": 0}

        for index, src_path in enumerate(src_files, start=1):
            # 文件系统操作均在线程池中执行，避免阻塞事件循环
            if not await asyncio.to_thread(src_path.exists):
                await _ws_send_skip(
                    websocket, stats, f"源文件 {src_path} 不存在，已跳过", src_path
                )
                continue

            if await asyncio.to_thread(src_path.is_file):
                dst_file = dst_path / src_path.name
                # 防御：目标即源文件本身（目标目录就是源所在目录），
                # 若继续会先 unlink 源再 link，导致源文件永久丢失
                if dst_file == src_path:
                    await _ws_send_skip(websocket, stats, "源与目标相同，跳过", src_path)
                    continue
                try:
                    if await asyncio.to_thread(dst_file.exists):
                        await asyncio.to_thread(dst_file.unlink)
                    await asyncio.to_thread(os.link, src_path, dst_file)
                    stats["linked"] += 1
                    await websocket.send_json(
                        {
                            "type": "progress",
                            "index": index,
                            "total": total,
                            "source": src_path.as_posix(),
                        }
                    )
                except OSError as e:
                    logger.error(
                        "链接文件 %s 到 %s 时出错: %s", src_path, dst_file, e
                    )
                    stats["failed"] += 1
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": _link_error_message(e),
                            "source": src_path.as_posix(),
                        }
                    )
            else:
                # 目录链接：防御自嵌套（dst 位于 src 内部时跳过）
                if dst_path.resolve().is_relative_to(src_path.resolve()):
                    await _ws_send_skip(
                        websocket,
                        stats,
                        f"目标路径位于源目录 {src_path} 内部，已跳过以避免自嵌套",
                        src_path,
                    )
                    continue

                await websocket.send_json(
                    {
                        "type": "info",
                        "message": f"开始链接文件夹 {src_path} ...",
                    }
                )
                async for frame in link_full_path_async(src_path, dst_path):
                    frame["index"] = index
                    frame["total"] = total
                    if frame["type"] == "progress":
                        stats["linked"] += 1
                    elif frame["type"] == "error":
                        stats["failed"] += 1
                    elif frame["type"] == "skip":
                        stats["skipped"] += 1
                    await websocket.send_json(frame)

        await websocket.send_json({"type": "done", **stats})
        await websocket.close()

    except WebSocketDisconnect:
        logger.info("客户端已断开连接")
    except Exception as e:
        logger.error("发生未预期的错误: %s", e)
        await _ws_send_error_and_close(websocket, f"发生错误: {e}")


async def link_full_path_async(
    src: Path, dst: Path
) -> AsyncGenerator[dict, None]:
    """递归链接整个目录到 dst / src.name，逐文件产生结构化进度帧。

    所有文件系统操作均在线程池中执行，避免阻塞事件循环。
    帧格式：
    - {"type": "progress", "current": i, "file_total": n, "source": "..."}
    - {"type": "error", "message": "...", "source": "..."}
    不在此函数中抛出 HTTPException，单文件失败记入 error 帧后继续。
    """
    src = src.resolve()
    dst = dst.resolve()
    folder_name = src.name

    # 防御：链接根 dst/src.name 与 src 相同（dst 恰好是 src 的父目录），
    # 继续执行会把目录内每个文件先删后链，造成数据丢失
    if (dst / folder_name) == src:
        yield {
            "type": "skip",
            "message": "源与目标相同，跳过",
            "source": src.as_posix(),
        }
        return

    def _collect_files() -> list[Path]:
        """一次性物化目录下的文件清单（跳过符号链接）。"""
        return [
            item
            for item in src.rglob("*")
            if item.is_file() and not item.is_symlink()
        ]

    try:
        file_list = await asyncio.to_thread(_collect_files)
    except Exception as e:
        logger.error("遍历源目录 %s 时出错: %s", src, e)
        yield {
            "type": "error",
            "message": f"遍历源目录失败: {e}",
            "source": src.as_posix(),
        }
        return

    file_total = len(file_list)

    for index, item in enumerate(file_list, start=1):
        relative_path = item.relative_to(src)
        target_path = dst / folder_name / relative_path
        # 防御：目标路径即源文件本身时绝不允许 unlink/link
        if target_path == item:
            yield {
                "type": "skip",
                "message": "源与目标相同，跳过",
                "source": item.as_posix(),
            }
            continue
        try:
            await asyncio.to_thread(
                target_path.parent.mkdir, parents=True, exist_ok=True
            )
            if await asyncio.to_thread(target_path.exists):
                try:
                    await asyncio.to_thread(target_path.unlink)
                except OSError as e:
                    raise OSError(e.errno, f"删除已存在的目标文件失败: {e.strerror}")

            await asyncio.to_thread(os.link, item, target_path)
            yield {
                "type": "progress",
                "current": index,
                "file_total": file_total,
                "source": item.as_posix(),
            }
        except OSError as e:
            logger.error("链接文件 %s 到 %s 时出错: %s", item, target_path, e)
            yield {
                "type": "error",
                "message": _link_error_message(e),
                "source": item.as_posix(),
            }
        except Exception as e:
            logger.error("处理文件 %s 时出错: %s", item, e)
            yield {
                "type": "error",
                "message": f"处理文件失败: {e}",
                "source": item.as_posix(),
            }


def file_info(item: Path, stat_info: os.stat_result | None = None) -> dict:
    """构造单个文件/目录的信息字典，文件类型附带硬链接数 nlink。"""
    if stat_info is None:
        stat_info = os.stat(item)
    is_dir = item.is_dir()
    info = {
        "name": item.name,
        "type": "directory" if is_dir else "file",
        "path": item.absolute().as_posix(),
        "size": "--" if is_dir else format_file_size(stat_info.st_size),
    }
    if not is_dir:
        info["nlink"] = stat_info.st_nlink
    return info


def format_file_size(bytes_num: float, decimal_places: int = 2) -> str:
    """将字节数格式化为带单位的可读字符串，如 "1.50 MB"。"""
    size_units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]

    if bytes_num <= 0:
        return "0 B"

    i = 0
    while bytes_num >= 1024 and i < len(size_units) - 1:
        bytes_num /= 1024.0
        i += 1

    return f"{bytes_num:.{decimal_places}f} {size_units[i]}"


def contains_single_link_file(path: Path) -> bool:
    """递归检查目录中是否存在硬链接数为 1 的文件。"""
    try:
        for item in path.rglob("*"):
            if item.is_file() and item.stat().st_nlink == 1:
                return True
    except Exception as e:
        logger.error("处理路径 %s 时出错: %s", path, e)
    return False
