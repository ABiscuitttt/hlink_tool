// DOM元素
const serverUrlInput = document.getElementById('server_url');
const statusMessage = document.getElementById('status-message');

// 操作按钮元素
const linkBtn = document.getElementById('link-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmMessage = document.getElementById('confirm-message');
const cancelBtn = document.getElementById('cancel-btn');
const confirmBtn = document.getElementById('confirm-btn');

// 文件面板元素
const srcList = document.getElementById('src-list');
const dstList = document.getElementById('dst-list');

var selectedFile = new Set([]);
var multiselectMode = false;
const refreshBtn = document.getElementById('refresh-btn');

// 路径显示条的textContent
var currentSrcPath = () => {
    return document.getElementById('src-path').textContent;
};
var currentDstPath = () => {
    return document.getElementById('dst-path').textContent;
};

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    // 获取默认目录
    updateStatus('正在获取默认目录', 'success');
    fetch("/api/default_dir")
        .then(res => {
            if (!res.ok) {
                updateStatus(`服务器响应错误: ${res.status}`, 'error');
                throw new Error(`服务器响应错误: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            const defaultDir = data.dir;
            console.log("默认目录:", defaultDir);
            // 加载初始文件列表
            updateStatus('正在加载文件列表', 'loading');
            const srcType = document.getElementById('filter-src').checked ? 'filter_dir' : 'list_dir';
            loadAndRenderFileList(defaultDir, srcList, srcType);
            loadAndRenderFileList(defaultDir, dstList, 'list_dir');
        })
        .catch(error => {
            updateStatus(`请求失败: ${error.message}`, 'error');
        });


    // 设置事件监听器
    setupEventListeners();
});

document.addEventListener('keydown', function (event) {
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
        multiselectMode = true;
    }
});

document.addEventListener('keyup', function (event) {
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
        multiselectMode = false;
    }
});

// 设置事件监听器
function setupEventListeners() {
    // 链接按钮相关
    linkBtn.addEventListener('click', showConfirmModal);
    cancelBtn.addEventListener('click', hideConfirmModal);
    confirmBtn.addEventListener('click', performLink);
    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) {
            hideConfirmModal();
        }
    });


    // 刷新按钮
    refreshBtn.addEventListener('click', () => {
        updateStatus('刷新中', 'loading');
        const srcType = document.getElementById('filter-src').checked ? 'filter_dir' : 'list_dir';
        loadAndRenderFileList(currentSrcPath(), srcList, srcType);
        loadAndRenderFileList(currentDstPath(), dstList, 'list_dir');
    });

    // 源目录筛选模式切换
    document.getElementById('filter-src').addEventListener('change', (event) => {
        const type = event.target.checked ? 'filter_dir' : 'list_dir';
        updateStatus('应用筛选模式', 'loading');
        loadAndRenderFileList(currentSrcPath(), srcList, type);
    });
}

// 加载并渲染文件列表
async function loadAndRenderFileList(path, listElement, type) {
    type = type || 'list_dir'; //默认api
    // 显示加载状态
    listElement.innerHTML = `
                <div class="loading">
                    <div class="spinner"></div>
                    <div>正在加载文件列表...</div>
                </div>
            `;

    try {
        const encodedPath = encodeURIComponent(path);
        const url = `/api/${type}?path=${encodedPath}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            throw new Error(`服务器响应错误: ${response.status}`);
        }

        const fileList = await response.json();

        pathDisplay = listElement.parentElement.querySelector(".path-display")
        pathDisplay.textContent = path;

        renderFileList(fileList, listElement);
        updateStatus(`${pathDisplay.getAttribute("type") === 'src' ? '源' : '目标'}目录加载完成`, 'success');

    } catch (error) {
        console.error('加载文件列表失败:', error);
        listElement.innerHTML = `
                    <div class="empty-directory">
                        加载失败: ${error.message}<br>
                        请检查服务器地址和网络连接
                    </div>
                `;
        updateStatus(`加载失败: ${error.message}`, 'error');
    }
}

// 渲染文件列表
function renderFileList(fileList, listElement) {
    listElement.innerHTML = '';
    type = listElement.parentElement.querySelector(".path-display").getAttribute("type") === 'src' ? 'src' : 'dst';

    if (!fileList || fileList.length === 0) {
        listElement.innerHTML = '<div class="empty-directory">此目录为空</div>';
        return;
    }

    fileList.forEach(item => {
        const fileItem = document.createElement('div');
        fileItem.className = `file-item`;

        const icon = item.type === 'directory' ? '📁' : '📄';

        fileItem.innerHTML = `
                    <div class="file-icon">${icon}</div>
                    <div class="file-name" title="${item.name}">${item.name}</div>
                    <div class="file-size">${item.size}</div>
                    <div class="file-path" style="display:none;">${item.path}</div>
                `;

        // 单击选择文件
        if (type === 'src') {
            fileItem.addEventListener('click', () => {
                selectFile(item, fileItem, type);
            })
        };

        // 双击进入目录
        fileItem.addEventListener('dblclick', () => {
            if (item.type === 'directory') {
                const newPath = item.path;
                const pathDisplay = listElement.parentElement.querySelector(".path-display")
                const type = pathDisplay.getAttribute("type") === 'src' ? (document.getElementById('filter-src').checked ? 'filter_dir' : 'list_dir') : 'list_dir';

                updateStatus(`正在进入目录: ${item.name}`, 'info');
                loadAndRenderFileList(newPath, listElement, type);
            }
        });

        listElement.appendChild(fileItem);
    });
}

// 选择文件
function selectFile(file, fileElement) {
    // 更新UI：清除之前的选择，高亮当前选择
    if (!multiselectMode) {
        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.remove('selected');
        });
        selectedFile.clear();
    }

    selectedFile.add(fileElement);
    fileElement.classList.add('selected');

    if (selectedFile.size > 1) {
        updateStatus(`已选择${selectedFile.size}个文件`, 'info');
    } else {
        updateStatus(`已选择: ${file.name}`, 'info');
    }
}

// 更新状态消息
function updateStatus(message, type = 'info') {
    statusMessage.innerHTML = message;

    // 根据类型更新状态指示器颜色
    if (type === 'error') {
        statusMessage.style.setProperty('--status-color', 'var(--danger-color)');
    } else if (type === 'success') {
        statusMessage.style.setProperty('--status-color', 'var(--success-color)');
    } else if (type === 'loading') {
        statusMessage.style.setProperty('--status-color', 'var(--warning-color)');
    } else {
        statusMessage.style.setProperty('--status-color', 'var(--success-color)');
    }
}

// 显示确认模态框
function showConfirmModal() {
    if (selectedFile.size == 0) {
        updateStatus('请先选择要链接的文件', 'error');
        return;
    }

    confirmMessage.textContent = `确定要将 ${selectedFile.size} 个文件链接到目标目录 ${currentDstPath()} 中吗？`;
    confirmModal.classList.add('active');
}

// 隐藏确认模态框
function hideConfirmModal() {
    confirmModal.classList.remove('active');
}


// 执行链接操作
async function performLink() {
    hideConfirmModal();
    updateStatus('正在创建硬链接...', 'loading');

    let ws = new WebSocket("/api/ws/link_files");

    ws.onopen = function () {
        let data_payload = { "link": true, "src_files": [], "dst_path": currentDstPath() };
        data_payload.src_files = Array.from(selectedFile).map(fileElem => {
            return fileElem.querySelector('.file-path').textContent;
        });
        ws.send(JSON.stringify(data_payload));
    };

    ws.onmessage = function (evt) {
        var received_msg = evt.data;
        updateStatus(received_msg, 'loading');
        console.log(received_msg);
    };

    ws.onclose = async function () {
        // 关闭 websocket
        console.log("连接已关闭...");
        await loadAndRenderFileList(currentDstPath(), dstList, 'list_dir');
        updateStatus(`成功将 ${selectedFile.size} 个文件(夹)链接到 ${currentDstPath()}`, 'success');
    };
}
