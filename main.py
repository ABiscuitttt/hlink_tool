import asyncio
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(root_path="/api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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


@app.get("/list_dir")
def list_directory(path: Path, filter_single_link: bool = False) -> list[dict]:
    path = _check_path(path)
    if not path.is_dir():
        logger.warning("请求的路径不是目录: %s", path)
        raise HTTPException(status_code=400, detail=f"请求的路径不是目录: {path}")

    results = []
    for item in path.iterdir():
        try:
            stat_info = item.stat(follow_symlinks=False)  # 缓存文件的元信息
            if filter_single_link:
                condition = (
                    False
                    or (item.is_file() and stat_info.st_nlink == 1)
                    or (item.is_dir() and contains_single_link_file(item))
                )
                if condition:
                    results.append(file_info(item, stat_info))
            else:
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

    def sort_key(item):
        return item["type"], item["name"]

    results.sort(key=sort_key)
    return results


@app.get("/dir_size")
def directory_size(path: Path) -> str:
    path = _check_path(path)
    if not path.is_dir():
        logger.warning("请求的路径不是目录: %s", path)
        raise HTTPException(status_code=400, detail=f"请求的路径不是目录: {path}")

    total_size = 0
    try:
        for item in path.rglob("*"):
            # 只统计常规文件，跳过符号链接和目录
            if item.is_file() and not item.is_symlink():
                try:
                    total_size += item.stat().st_size
                except Exception as e:
                    logger.error("获取文件大小时出错 %s: %s", item, e)
    except Exception as e:
        logger.error("遍历目录时出错 %s: %s", path, e)

    return format_file_size(total_size)


@app.get("/create_dir")
def create_dir(path: Path, name: str):
    path = _check_path(path)
    new_folder_path = path / name

    # 检查名字是否合法
    if any(char in name for char in r'\/:*?"<>|'):
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
def default_dir():
    return {"dir": os.environ.get("DEFAULT_DIR", "/data")}


@app.websocket("/ws/link_files")
async def websocket_progress(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            data: dict = await websocket.receive_json()
            if data.get("link"):
                break

        src_files = [Path(src) for src in data.get("src_files", [])]
        dst_path = Path(data.get("dst_path", ""))
        if not dst_path.is_dir():
            await websocket.send_text("目标路径不是有效的目录")
            return

        for index, src_path in enumerate(src_files, start=1):
            if not src_path.exists():
                await websocket.send_text(f"源文件 {src_path} 不存在，跳过...")
                continue

            if src_path.is_file():
                await websocket.send_text(
                    f"正在处理 ({index}/{len(src_files)}) 链接 {src_path}..."
                )
                dst_file = dst_path / src_path.name
                try:
                    if dst_file.exists():
                        dst_file.unlink()
                    os.link(src_path, dst_file)
                except Exception as e:
                    logger.error("链接文件 %s 到 %s 时出错: %s", src_path, dst_file, e)
                    await websocket.send_text(f"链接文件 {src_path} 时出错: {e}")
            else:
                async for progress in link_full_path_async(src_path, dst_path):
                    await websocket.send_text(
                        f"正在处理 ({index}/{len(src_files)})<br>"
                        + f"文件夹内剩余 ({progress['current']}/{progress['total']}) 链接 {progress['source']} ..."  # noqa: E501
                    )

        await websocket.send_text("链接已全部完成")
        await asyncio.sleep(1)

    except WebSocketDisconnect:
        logger.info("客户端已断开连接")
    except Exception as e:
        logger.error("发生未预期的错误: %s", e)
        await websocket.send_text(f"发生错误: {e}")


async def link_full_path_async(src: Path, dst: Path):
    if not src.is_dir() or not dst.is_dir():
        raise HTTPException(status_code=400, detail="源或目标路径不是有效的目录")

    src = src.resolve()
    dst = dst.resolve()
    folder_name = src.name

    total_files = sum(1 for _ in src.rglob("*") if _.is_file())  # 计算总文件数
    file_list = (item for item in src.rglob("*") if item.is_file())

    for index, item in enumerate(file_list, start=1):
        try:
            relative_path = item.relative_to(src)
            target_path = dst / folder_name / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)

            if target_path.exists():
                target_path.unlink()

            os.link(item, target_path)
            yield {
                "current": index,
                "total": total_files,
                "source": item.as_posix(),
                "target": target_path.as_posix(),
            }
        except Exception as e:
            logger.error("链接文件 %s 到 %s 时出错: %s", item, target_path, e)


def file_info(item: Path, stat_info: os.stat_result | None = None) -> dict:
    if stat_info is None:
        stat_info = os.stat(item)
    item_type = "directory" if item.is_dir() else "file"
    item_size = "--" if item.is_dir() else format_file_size(stat_info.st_size)
    return {
        "name": item.name,
        "type": item_type,
        "path": item.absolute().as_posix(),
        "size": item_size,
    }


def format_file_size(bytes_num, decimal_places=2):
    """
    将字节数转换为可读性好的文件大小字符串

    参数:
    bytes_num (int): 字节数
    decimal_places (int): 保留的小数位数，默认为2

    返回:
    str: 格式化的文件大小字符串
    """
    size_units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]

    # 处理字节数为0的情况
    if bytes_num <= 0:
        return "0 B"

    # 找到合适的单位
    i = 0
    while bytes_num >= 1024 and i < len(size_units) - 1:
        bytes_num /= 1024.0
        i += 1

    # 格式化输出
    return f"{bytes_num:.{decimal_places}f} {size_units[i]}"


def contains_single_link_file(path: Path) -> bool:
    try:
        for item in path.rglob("*"):  # 递归遍历所有文件和目录
            if item.is_file() and item.stat().st_nlink == 1:
                return True
    except Exception as e:
        logger.error("处理路径 %s 时出错: %s", path, e)
    return False



