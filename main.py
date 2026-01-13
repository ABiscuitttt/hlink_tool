import asyncio
import io
import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(root_path="/api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,  # 允许携带凭证
    allow_methods=["*"],  # 允许所有HTTP方法
    allow_headers=["*"],  # 允许所有请求头
)


@app.get("/list_dir")
def listdir(path: str):
    path: Path = Path(path).absolute()
    if not Path(path).exists():
        raise HTTPException(
            status_code=400, detail=f"{path} does not exist")
    if not path.is_dir():
        raise HTTPException(
            status_code=400, detail=f"{path} is not a directory")

    di = dir_info(path)
    if path.parent != path:
        di.append(
            {
                "name": "..",
                "type": "directory",
                "path": path.parent.absolute().as_posix(),
                "size": "--",
            }
        )
    di.sort(key=lambda x: x["name"])
    di.sort(key=lambda x: x["type"])
    return di


@app.get("/filter_dir")
def filter_dir(path: str):
    path: Path = Path(path).absolute()
    if not Path(path).exists():
        raise HTTPException(
            status_code=400, detail=f"{path} does not exist")
    if not path.is_dir():
        raise HTTPException(
            status_code=400, detail=f"{path} is not a directory")

    results = []
    for item in path.iterdir():
        if item.is_file() and item.stat().st_nlink == 1:
            results.append(file_info(item))
        if item.is_dir() and check_if_has_1link(item):
            results.append(file_info(item))

    if path.parent != path:
        results.append(
            {
                "name": "..",
                "type": "directory",
                "path": path.parent.absolute().as_posix(),
                "size": "--",
            }
        )
    results.sort(key=lambda x: x["name"])
    results.sort(key=lambda x: x["type"])
    return results


@app.get("/default_dir")
def default_dir():
    return {'dir': os.environ.get('DEFAULT_DIR', '/data')}


@app.websocket("/ws/link_files")
async def websocket_progress(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            data = await websocket.receive_json()
            if data["link"] == True:
                break
        src_files: list[str] = data["src_files"]
        dst_path: str = data["dst_path"]

        for index, src_path in enumerate(src_files):
            src_path = Path(src_path)
            if src_path.is_file():
                await websocket.send_text(f"正在处理 ({index+1}/{len(src_files)}) 链接 {src_path}...")
                dst_file = Path(dst_path) / src_path.name
                os.link(src_path, dst_file)
            else:
                for index2, total, src, dst in link_full_path(src_path, Path(dst_path)):
                    await websocket.send_text(f"正在处理 ({index+1}/{len(src_files)})<br>文件夹内剩余 ({index2}/{total}) 链接 {src} ...")
        await websocket.send_text("链接已全部完成")
        await asyncio.sleep(1)

    except WebSocketDisconnect:
        print(f"Client disconnected")


def dir_info(path: Path) -> list[dict]:
    return [file_info(item) for item in path.glob("*")]


def file_info(item: Path) -> dict:
    info = os.stat(item)
    item_type = "directory" if item.is_dir() else "file"
    item_size = "--" if item.is_dir() else format_file_size(info.st_size)
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
    if bytes_num < 0:
        return "0 B"

    size_units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]

    # 处理字节数为0的情况
    if bytes_num == 0:
        return "0 B"

    # 找到合适的单位
    i = 0
    while bytes_num >= 1024 and i < len(size_units) - 1:
        bytes_num /= 1024.0
        i += 1

    # 格式化输出
    return f"{bytes_num:.{decimal_places}f} {size_units[i]}"


def check_if_has_1link(path: Path) -> bool:
    if not path.is_dir():
        raise NotADirectoryError(f"{path} is not a directory")

    for item in path.iterdir():
        if item.is_file() and item.stat().st_nlink == 1:
            return True
        if item.is_dir():
            if check_if_has_1link(item):
                return True
    return False


def link_full_path(src: Path, dst: Path):
    assert src.is_dir(), f"{src} is not a directory"
    assert dst.is_dir(), f"{dst} is not a directory"
    src = src.resolve()
    dst = dst.resolve()

    file_list = list([i for i in src.rglob("*") if i.is_file()])
    total_files = len(file_list)
    folder_name = src.name
    for index, item in enumerate(file_list):
        relative_path = item.relative_to(src)
        target_path = dst / folder_name / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if target_path.exists():
            target_path.unlink()
        yield (index+1, total_files, item.as_posix(), target_path.as_posix())
        os.link(item, target_path)
