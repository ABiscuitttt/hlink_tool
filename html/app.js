// 文件面板元素
const srcList = document.getElementById('src-list');
const dstList = document.getElementById('dst-list');

// 全局状态
const appState = {
    selectedFiles: new Set(),
    dirSizeCache: {},
    multiselectMode: false,
    get srcPath() { return document.getElementById('src-path').value; },
    get dstPath() { return document.getElementById('dst-path').value; }
};

// 初始化应用
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
    try {
        const default_dir = await setupDefaultDirectories();
        await loadInitialFileLists(default_dir);
        setupEventListeners();
        updateStatus('应用初始化完成', 'success');
    } catch (error) {
        updateStatus(`初始化失败: ${error.message}`, 'error');
    }
}

// 设置默认目录
async function setupDefaultDirectories() {
    updateStatus('正在获取默认目录', 'loading');
    const response = await fetch("/api/default_dir");

    if (!response.ok) {
        if (response.status === 400) throw new Error('无法获取默认目录');
        throw new Error(`服务器响应错误: ${response.status}`);
    }

    const { dir } = await response.json();
    updateStatus('默认目录获取成功', 'success');
    return dir;
}

// 加载初始文件列表
async function loadInitialFileLists(defaultDir) {
    updateStatus('正在加载文件列表', 'loading');
    const isFilterEnabled = document.getElementById('filter-src').checked;

    await Promise.all([
        loadAndRenderFileList(defaultDir, srcList, isFilterEnabled),
        loadAndRenderFileList(defaultDir, dstList, false)
    ]);

    updateStatus('文件列表加载完成', 'success');
}

// 设置事件监听器
async function setupEventListeners() {
    setupNewFolderModals();
    setupLinkOperations();
    setupRefreshButton();
    setupFilterToggle();
    enablePathEdit();
    setupMultiSelectKeys();
    setupKeyboardShortcuts();
}

// 新建文件夹模态框相关
async function setupNewFolderModals() {
    bindNewFolderModal('src');
    bindNewFolderModal('dst');
}

async function bindNewFolderModal(type) {
    const pathInputId = `${type}-path`;
    const listElement = type === 'src' ? srcList : dstList;
    const btn = document.getElementById(`${type}-new-folder-btn`);

    if (!btn) return;

    btn.addEventListener('click', () => showNewFolderModal(type, pathInputId, listElement));
}

async function showNewFolderModal(type, pathInputId, listElement) {
    const modal = document.getElementById('new-folder-modal');
    const message = modal.querySelector('#new-folder-message');
    const confirmBtn = modal.querySelector('#new-folder-confirm-btn');
    const cancelBtn = modal.querySelector('#new-folder-cancel-btn');

    // 创建输入框
    message.innerHTML = '<input type="text" id="new-folder-input" placeholder="请输入新文件夹名称" class="folder-input">';
    modal.classList.add('active');

    // 事件处理器
    const closeModal = () => modal.classList.remove('active');

    const handleCancel = () => closeModal();

    const handleConfirm = async () => {
        const input = document.getElementById('new-folder-input');
        const folderName = input.value.trim();

        if (!folderName) {
            input.focus();
            input.classList.add('error');
            return;
        }

        input.classList.remove('error');
        closeModal();

        const currentPath = document.getElementById(pathInputId).value;
        await createNewFolder(currentPath, folderName, type, listElement);
    };

    const handleOverlayClick = (e) => {
        if (e.target === modal) closeModal();
    };

    // 绑定事件
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    modal.addEventListener('click', handleOverlayClick);


    // 设置输入框焦点和回车支持
    setTimeout(() => {
        const input = document.getElementById('new-folder-input');
        if (input) {
            input.focus();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleConfirm();
            });
        }
    }, 50);
}

async function createNewFolder(currentPath, folderName, type, listElement) {
    try {
        const response = await fetch(
            `/api/create_dir?path=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(folderName)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || response.status);
        }

        updateStatus('文件夹创建成功', 'success');
        const isFilterEnabled = type === 'src' && document.getElementById('filter-src').checked;
        await loadAndRenderFileList(currentPath, listElement, isFilterEnabled);
    } catch (error) {
        updateStatus(`新建文件夹失败: ${error.message}`, 'error');
    }
}

// 链接操作相关
function setupLinkOperations() {
    const linkBtn = document.getElementById('link-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const linkConfirmBtn = document.getElementById('confirm-btn');
    const confirmModal = document.getElementById('confirm-modal');

    linkBtn.addEventListener('click', showLinkConfirmModal);
    cancelBtn.addEventListener('click', hideLinkConfirmModal);
    linkConfirmBtn.addEventListener('click', handleLinkConfirm);

    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) hideLinkConfirmModal();
    });
}

function showLinkConfirmModal() {
    if (appState.selectedFiles.size === 0) {
        updateStatus('请先选择要链接的文件', 'error');
        return;
    }

    const confirmMessage = document.getElementById('confirm-message');
    confirmMessage.textContent = `确定要将 ${appState.selectedFiles.size} 个文件链接到目标目录 ${appState.dstPath} 中吗？`;
    document.getElementById('confirm-modal').classList.add('active');
}

function hideLinkConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('active');
}

async function handleLinkConfirm() {
    hideLinkConfirmModal();
    updateStatus('正在创建硬链接...', 'loading');

    const ws = new WebSocket("/api/ws/link_files");

    ws.onopen = () => {
        updateStatus('已连接服务器，开始发送链接请求...', 'loading');
        const payload = {
            link: true,
            src_files: Array.from(appState.selectedFiles).map(fileElem =>
                fileElem.querySelector('.file-path').textContent
            ),
            dst_path: appState.dstPath
        };
        ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (evt) => updateStatus(evt.data, 'loading');

    ws.onerror = () => {
        updateStatus('WebSocket 连接发生错误', 'error');
    };

    ws.onclose = async () => {
        updateStatus('链接操作已完成，正在刷新目标目录...', 'success');
        await loadAndRenderFileList(appState.dstPath, dstList, false);
        updateStatus(`成功将 ${appState.selectedFiles.size} 个文件(夹)链接到 ${appState.dstPath}`, 'success');
    };
}

// 刷新按钮
function setupRefreshButton() {
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        updateStatus('刷新中', 'loading');

        // 清除文件夹大小缓存
        Object.keys(appState.dirSizeCache).forEach(key => {
            delete appState.dirSizeCache[key];
        });

        const isFilterEnabled = document.getElementById('filter-src').checked;
        await Promise.all([
            loadAndRenderFileList(appState.srcPath, srcList, isFilterEnabled),
            loadAndRenderFileList(appState.dstPath, dstList, false)
        ]);
    });
}

// 筛选切换
function setupFilterToggle() {
    document.getElementById('filter-src').addEventListener('change', () => {
        const isFilterEnabled = document.getElementById('filter-src').checked;
        updateStatus('应用筛选模式', 'loading');
        loadAndRenderFileList(appState.srcPath, srcList, isFilterEnabled);
    });
}

// 多选模式
function setupMultiSelectKeys() {
    document.addEventListener('keydown', (event) => {
        if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
            appState.multiselectMode = true;
        }
    });

    document.addEventListener('keyup', (event) => {
        if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
            appState.multiselectMode = false;
        }
    });

    window.addEventListener('blur', () => {
        appState.multiselectMode = false;
    });
}

// 键盘快捷键
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        // Ctrl+L: 触发链接操作
        if (event.ctrlKey && event.key === 'l') {
            event.preventDefault();
            showLinkConfirmModal();
        }
        // Escape: 清除所有选择
        if (event.key === 'Escape' && !document.querySelector('.modal-overlay.active')) {
            clearAllSelections();
            updateStatus('已清除选择', 'info');
        }
    });
}

// 路径编辑支持
function enablePathEdit() {
    document.querySelectorAll('.path-display-input').forEach(el => {
        el.addEventListener('keydown', function (e) {
            const type = el.dataset.type;
            if (e.key === 'Enter') {
                e.preventDefault();
                const newPath = el.value.trim();
                const isFilterEnabled = type === 'src' && document.getElementById('filter-src').checked;
                loadAndRenderFileList(newPath, type === 'src' ? srcList : dstList, isFilterEnabled);
            } else if (e.key === 'Escape') {
                el.value = type === 'src' ? appState.srcPath : appState.dstPath;
            }
        });
    });
}

// 文件列表管理
async function loadAndRenderFileList(path, listElement, filterSingleLink = false) {
    updateStatus('正在加载文件列表...', 'loading');
    listElement.innerHTML = createLoadingHTML('正在加载文件列表...');

    try {
        const params = new URLSearchParams({ path, filter_single_link: filterSingleLink });
        const response = await fetch(`/api/list_dir?${params.toString()}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            if (response.status === 400) {
                const error = await response.json();
                throw new Error(error.detail || '无法加载文件列表');
            }
            throw new Error(`服务器响应错误: ${response.status}`);
        }

        const fileList = await response.json();
        const pathDisplay = listElement.parentElement.querySelector(".path-display-input");
        pathDisplay.value = path;

        renderFileList(fileList, listElement);
        const panelType = pathDisplay.getAttribute("data-type") === 'src' ? '源' : '目标';
        updateStatus(`${panelType}目录加载完成`, 'success');

    } catch (error) {
        const type = listElement.id === 'src-list' ? 'src' : 'dst';
        listElement.innerHTML = createErrorHTML(error.message, type);
        bindRetryDefaultBtn(listElement, type);
        updateStatus(`加载失败: ${error.message}`, 'error');
    }
}

function renderFileList(fileList, listElement) {
    listElement.innerHTML = '';
    const type = listElement.id === 'src-list' ? 'src' : 'dst';

    if (!fileList || fileList.length === 0) {
        updateStatus('此目录为空', 'info');
        listElement.innerHTML = '<div class="empty-directory"><div class="empty-icon">📭</div>此目录为空</div>';
        return;
    }

    fileList.forEach(item => createFileItem(item, listElement, type));

    // 异步加载文件夹大小
    loadDirectorySizes(listElement);
}

function createFileItem(item, listElement, type) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    if (item.isParent) {
        fileItem.classList.add('parent-dir');
    }

    const icon = item.type === 'directory' ? '📁' : '📄';
    const sizeHtml = getSizeHtml(item);

    fileItem.innerHTML = `
        <div class="file-icon">${icon}</div>
        <div class="file-name" title="${item.name}">${item.name}</div>
        <div class="file-size">${sizeHtml}</div>
        <div class="file-path" style="display:none;">${item.path}</div>
    `;

    // 源面板支持选择文件
    if (type === 'src') {
        fileItem.addEventListener('click', () => selectFile(item, fileItem));
    }

    // 双击进入目录
    fileItem.addEventListener('dblclick', () => {
        if (item.type === 'directory') {
            handleDirectoryDoubleClick(item, listElement);
        }
    });

    listElement.appendChild(fileItem);
}

function getSizeHtml(item) {
    if (item.type === 'directory') {
        if (appState.dirSizeCache[item.path]) {
            return `<span class="dir-size" data-path="${item.path}">${appState.dirSizeCache[item.path]}</span>`;
        }
        return `<span class="dir-size" data-path="${item.path}">计算中...</span>`;
    }
    return item.size;
}

function handleDirectoryDoubleClick(item, listElement) {
    updateStatus(`正在进入目录: ${item.name}`, 'loading');
    const newPath = item.path;
    const pathDisplay = listElement.parentElement.querySelector(".path-display-input");
    const isSrc = pathDisplay.getAttribute("data-type") === 'src';
    const isFilterEnabled = isSrc && document.getElementById('filter-src').checked;
    loadAndRenderFileList(newPath, listElement, isFilterEnabled);
}

async function loadDirectorySizes(listElement) {
    const dirSizeSpans = listElement.querySelectorAll('.dir-size');

    const tasks = Array.from(dirSizeSpans).map(async span => {
        const dirPath = span.getAttribute('data-path');

        if (appState.dirSizeCache[dirPath]) {
            span.textContent = appState.dirSizeCache[dirPath];
            return;
        }

        try {
            const response = await fetch(`/api/dir_size?path=${encodeURIComponent(dirPath)}`);
            if (!response.ok) throw new Error('获取文件夹大小失败');

            const data = await response.json();
            const size = data || '未知';
            appState.dirSizeCache[dirPath] = size;
            span.textContent = size;
        } catch (e) {
            appState.dirSizeCache[dirPath] = '未知';
            span.textContent = '未知';
        }
    });

    await Promise.allSettled(tasks);
}

// 文件选择功能
function selectFile(file, fileElement) {
    if (appState.selectedFiles.has(fileElement)) {
        // 取消选择
        fileElement.classList.remove('selected');
        appState.selectedFiles.delete(fileElement);
    } else {
        // 选择文件
        if (!appState.multiselectMode) {
            clearAllSelections();
        }

        appState.selectedFiles.add(fileElement);
        fileElement.classList.add('selected');
    }

    updateSelectionStatus(file);
}

function clearAllSelections() {
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    appState.selectedFiles.clear();
}

function updateSelectionStatus(file) {
    if (appState.selectedFiles.size === 0) {
        updateStatus('未选择任何文件', 'info');
    } else if (appState.selectedFiles.size === 1) {
        updateStatus(`已选择: ${file.name}`, 'info');
    } else {
        updateStatus(`已选择${appState.selectedFiles.size}个文件`, 'info');
    }
}

// 返回默认目录功能
function bindRetryDefaultBtn(listElement, type) {
    const btn = listElement.querySelector('.retry-default-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        updateStatus('正在返回默认目录...', 'loading');
        await retryDefaultDirectory(type);
    });
}

async function retryDefaultDirectory(type) {
    try {
        const response = await fetch('/api/default_dir');
        if (!response.ok) throw new Error('无法获取默认目录');

        const { dir } = await response.json();
        updateStatus('默认目录获取成功', 'success');

        const pathInput = document.getElementById(`${type}-path`);
        pathInput.value = dir;

        const isFilterEnabled = type === 'src' && document.getElementById('filter-src').checked;
        await loadAndRenderFileList(dir, type === 'src' ? srcList : dstList, isFilterEnabled);

    } catch (error) {
        updateStatus(`返回默认目录失败: ${error.message}`, 'error');
    }
}

// UI辅助函数
function createLoadingHTML(message) {
    return `
        <div class="loading">
            <div class="spinner"></div>
            <div style="font-size:15px;font-weight:500;">${message}</div>
        </div>
    `;
}

function createErrorHTML(message, type = 'src') {
    return `
        <div class="empty-directory">
            <div style="font-size:15px;font-weight:500;">加载失败<br>${message}</div>
            <button class="btn retry-default-btn" data-type="${type}">尝试返回默认目录</button>
        </div>
    `;
}

function updateStatus(message, type = 'info') {
    const statusMessage = document.getElementById('status-message');

    const plainText = message.replace(/<br\s*\/?>/gi, ' | ');
    statusMessage.textContent = plainText;

    const statusColors = {
        error: 'var(--danger-color)',
        success: 'var(--success-color)',
        loading: 'var(--warning-color)',
        info: 'var(--success-color)'
    };

    statusMessage.style.setProperty('--status-color', statusColors[type] || statusColors.info);
}