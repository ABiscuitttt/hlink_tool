'use strict';

/* =====================================================================
 * hlink-tool 前端逻辑
 * - 双面板文件浏览（源面板可选，目标面板导航）
 * - WebSocket 实时创建硬链接（结构化 JSON 协议）
 * ===================================================================== */

// ---------- DOM 引用 ----------
const srcList = document.getElementById('src-list');
const dstList = document.getElementById('dst-list');
const statusMessage = document.getElementById('status-message');
const filterCheckbox = document.getElementById('filter-src');
const confirmModal = document.getElementById('confirm-modal');
const newFolderModal = document.getElementById('new-folder-modal');
const newFolderInput = document.getElementById('new-folder-input');

// ---------- 全局状态 ----------
const appState = {
    /** 源面板中选中的文件路径集合（只跟踪源面板，避免 stale DOM 引用） */
    selectedPaths: new Set(),
    /** 目录大小缓存：path -> 大小字符串 */
    dirSizeCache: new Map(),
    /** Ctrl 多选模式 */
    multiselectMode: false,
    /** 新建文件夹模态框当前作用的面板：'src' | 'dst' */
    newFolderTarget: 'src',
    get srcPath() { return document.getElementById('src-path').value; },
    get dstPath() { return document.getElementById('dst-path').value; }
};

/** 细线内联 SVG 图标 */
const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/></svg>'
};

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
    setupEventListeners();
    try {
        const defaultDir = await fetchDefaultDir();
        updateStatus('正在加载文件列表', 'loading');
        await Promise.all([
            loadAndRenderFileList(defaultDir, srcList, filterCheckbox.checked),
            loadAndRenderFileList(defaultDir, dstList, false)
        ]);
        updateStatus('初始化完成', 'success');
    } catch (error) {
        updateStatus(`初始化失败: ${error.message}`, 'error');
    }
}

function setupEventListeners() {
    setupNewFolderModal();
    setupLinkOperations();
    setupRefreshButton();
    setupFilterToggle();
    setupPathInputs();
    setupMultiSelectKeys();
    setupKeyboardShortcuts();
}

// ---------- API：默认目录 ----------
async function fetchDefaultDir() {
    const response = await fetch('/api/default_dir');
    if (!response.ok) throw new Error(`无法获取默认目录 (HTTP ${response.status})`);
    const { dir } = await response.json();
    return dir;
}

/* =====================================================================
 * 新建文件夹（模态框事件只绑定一次，目标面板记录在 appState）
 * ===================================================================== */
function setupNewFolderModal() {
    const confirmBtn = document.getElementById('new-folder-confirm-btn');
    const cancelBtn = document.getElementById('new-folder-cancel-btn');

    document.getElementById('src-new-folder-btn').addEventListener('click', () => openNewFolderModal('src'));
    document.getElementById('dst-new-folder-btn').addEventListener('click', () => openNewFolderModal('dst'));

    confirmBtn.addEventListener('click', handleNewFolderConfirm);
    cancelBtn.addEventListener('click', closeNewFolderModal);
    newFolderModal.addEventListener('click', (e) => {
        if (e.target === newFolderModal) closeNewFolderModal();
    });
    newFolderInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleNewFolderConfirm();
        }
    });
}

function openNewFolderModal(type) {
    appState.newFolderTarget = type;
    newFolderInput.value = '';
    newFolderInput.classList.remove('error');
    newFolderModal.classList.add('active');
    setTimeout(() => newFolderInput.focus(), 50);
}

function closeNewFolderModal() {
    newFolderModal.classList.remove('active');
}

async function handleNewFolderConfirm() {
    const folderName = newFolderInput.value.trim();
    if (!folderName) {
        newFolderInput.focus();
        newFolderInput.classList.add('error');
        return;
    }
    newFolderInput.classList.remove('error');
    closeNewFolderModal();

    const type = appState.newFolderTarget;
    const currentPath = type === 'src' ? appState.srcPath : appState.dstPath;
    await createNewFolder(currentPath, folderName, type);
}

/** 按契约：POST /api/create_dir，JSON 请求体 {path, name} */
async function createNewFolder(currentPath, folderName, type) {
    try {
        const response = await fetch('/api/create_dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name: folderName })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }

        updateStatus('文件夹创建成功', 'success');
        await loadPanel(currentPath, type);
    } catch (error) {
        updateStatus(`新建文件夹失败: ${error.message}`, 'error');
    }
}

/* =====================================================================
 * 硬链接操作（WebSocket 结构化 JSON 协议）
 * ===================================================================== */
function setupLinkOperations() {
    document.getElementById('link-btn').addEventListener('click', showLinkConfirmModal);
    document.getElementById('cancel-btn').addEventListener('click', hideLinkConfirmModal);
    document.getElementById('confirm-btn').addEventListener('click', handleLinkConfirm);
    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) hideLinkConfirmModal();
    });
}

function showLinkConfirmModal() {
    const count = getSelectedCount();
    if (count === 0) {
        updateStatus('请先在源目录选择要链接的文件', 'error');
        return;
    }
    document.getElementById('confirm-message').textContent =
        `确定要将选中的 ${count} 个文件(夹)链接到目标目录 ${appState.dstPath} 中吗？`;
    confirmModal.classList.add('active');
}

function hideLinkConfirmModal() {
    confirmModal.classList.remove('active');
}

function handleLinkConfirm() {
    hideLinkConfirmModal();
    const srcFiles = Array.from(appState.selectedPaths);
    if (srcFiles.length === 0) return;

    updateStatus('正在连接服务器...', 'loading');
    const ws = new WebSocket('/api/ws/link_files');
    /** 汇总结果：收到 done 帧后据此显示最终状态 */
    const result = { done: false, linked: 0, failed: 0, skipped: 0 };

    ws.onopen = () => {
        ws.send(JSON.stringify({ link: true, src_files: srcFiles, dst_path: appState.dstPath }));
    };

    ws.onmessage = (evt) => handleWsMessage(evt, result);

    ws.onerror = () => updateStatus('WebSocket 连接发生错误', 'error');

    ws.onclose = async () => {
        // 先清空选择并刷新目标目录（刷新会覆盖状态栏），最后再写总结
        clearAllSelections();
        await loadAndRenderFileList(appState.dstPath, dstList, false);
        if (result.done) {
            const hasFailure = result.failed > 0;
            updateStatus(
                `完成：链接 ${result.linked} 项 · 失败 ${result.failed} · 跳过 ${result.skipped}`,
                hasFailure ? 'error' : 'success'
            );
        } else {
            // 未收到 done 帧即断开，不能谎报成功
            updateStatus('连接中断，链接结果未知', 'error');
        }
    };
}

/** 解析服务端 JSON 帧并分发（服务端只发结构化 JSON） */
function handleWsMessage(evt, result) {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
        case 'progress':
            showWsProgress(msg);
            break;
        case 'info':
            updateStatus(msg.message, 'info');
            break;
        case 'skip':
            updateStatus(`跳过：${msg.message}`, 'warning');
            break;
        case 'error':
            updateStatus(`错误：${msg.message}`, 'error');
            break;
        case 'done':
            result.done = true;
            result.linked = msg.linked ?? 0;
            result.failed = msg.failed ?? 0;
            result.skipped = msg.skipped ?? 0;
            break;
    }
}

/** 进度帧：正在处理 (i/n)，目录时附带文件夹内进度；文件名等宽、截断 */
function showWsProgress(msg) {
    const name = msg.source ? String(msg.source).split('/').pop() : '';
    let head = `正在处理 (${msg.index}/${msg.total})`;
    if (msg.file_total != null) {
        head += ` 文件夹内 ${msg.current}/${msg.file_total}`;
    }

    statusMessage.textContent = '';
    statusMessage.append(document.createTextNode(head + ' '));
    const pathSpan = document.createElement('span');
    pathSpan.className = 'progress-path';
    pathSpan.textContent = truncateMiddle(String(name), 36);
    pathSpan.title = String(msg.source || '');
    statusMessage.append(pathSpan);
    setStatusColor('loading');
}

/** 中段截断，避免超长文件名撑爆状态栏 */
function truncateMiddle(text, maxLen) {
    if (text.length <= maxLen) return text;
    const keep = maxLen - 1;
    const headLen = Math.ceil(keep / 2);
    const tailLen = Math.floor(keep / 2);
    return text.slice(0, headLen) + '…' + text.slice(text.length - tailLen);
}

/* =====================================================================
 * 刷新 / 筛选 / 路径输入
 * ===================================================================== */
function setupRefreshButton() {
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        updateStatus('刷新中', 'loading');
        appState.dirSizeCache.clear();
        await Promise.all([
            loadAndRenderFileList(appState.srcPath, srcList, filterCheckbox.checked),
            loadAndRenderFileList(appState.dstPath, dstList, false)
        ]);
    });
}

function setupFilterToggle() {
    filterCheckbox.addEventListener('change', () => {
        updateStatus('应用筛选模式', 'loading');
        loadAndRenderFileList(appState.srcPath, srcList, filterCheckbox.checked);
    });
}

/** 路径输入框：回车跳转，Esc 还原当前路径 */
function setupPathInputs() {
    document.querySelectorAll('.path-display-input').forEach(el => {
        el.addEventListener('keydown', (e) => {
            const type = el.dataset.type;
            if (e.key === 'Enter') {
                e.preventDefault();
                loadPanel(el.value.trim() || '/', type);
            } else if (e.key === 'Escape') {
                e.stopPropagation(); // 输入框自己的 Esc：还原路径，不触发全局清除选择
                el.value = type === 'src' ? appState.srcPath : appState.dstPath;
                el.blur();
            }
        });
    });
}

/* =====================================================================
 * 多选与快捷键
 * ===================================================================== */
function setupMultiSelectKeys() {
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Control') appState.multiselectMode = true;
    });
    document.addEventListener('keyup', (event) => {
        if (event.key === 'Control') appState.multiselectMode = false;
    });
    window.addEventListener('blur', () => {
        appState.multiselectMode = false;
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        // Ctrl+L：发起链接
        if (event.ctrlKey && (event.key === 'l' || event.key === 'L')) {
            event.preventDefault();
            showLinkConfirmModal();
            return;
        }
        if (event.key !== 'Escape') return;

        // 模态框打开时：Esc 关闭模态框（即使焦点在模态框输入框内）
        const openModal = document.querySelector('.modal-overlay.active');
        if (openModal) {
            openModal.classList.remove('active');
            return;
        }
        // 焦点在输入框内时：不拦截 Esc，交给输入框自身逻辑
        const tag = event.target && event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        clearAllSelections();
        updateStatus('已清除选择', 'info');
    });
}

/* =====================================================================
 * 文件列表加载与渲染
 * ===================================================================== */
/** 按面板类型加载目录（源面板跟随筛选开关） */
function loadPanel(path, type) {
    return loadAndRenderFileList(
        path, type === 'src' ? srcList : dstList, type === 'src' && filterCheckbox.checked
    );
}

async function loadAndRenderFileList(path, listElement, filterSingleLink = false) {
    const type = listElement.id === 'src-list' ? 'src' : 'dst';
    updateStatus('正在加载文件列表...', 'loading');
    showLoading(listElement, '正在加载文件列表...');

    try {
        const params = new URLSearchParams({ path, filter_single_link: filterSingleLink });
        const response = await fetch(`/api/list_dir?${params.toString()}`);
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `服务器响应错误: ${response.status}`);
        }

        const fileList = await response.json();
        const pathDisplay = listElement.parentElement.querySelector('.path-display-input');
        pathDisplay.value = path;

        // 源列表重新渲染时清空选择，杜绝 stale 引用
        if (type === 'src') appState.selectedPaths.clear();

        const count = renderFileList(fileList, listElement, type);
        const panelName = type === 'src' ? '源' : '目标';
        updateStatus(count === 0 ? `${panelName}目录为空` : `${panelName}目录加载完成`,
            count === 0 ? 'info' : 'success');
    } catch (error) {
        showLoadError(listElement, type, error.message);
        updateStatus(`加载失败: ${error.message}`, 'error');
    }
}

function renderFileList(fileList, listElement, type) {
    listElement.textContent = '';

    if (!fileList || fileList.length === 0) {
        // 空目录：中性提示，不是错误
        const empty = document.createElement('div');
        empty.className = 'empty-directory';
        empty.textContent = '此目录为空';
        listElement.appendChild(empty);
        return 0;
    }

    const fragment = document.createDocumentFragment();
    fileList.forEach(item => fragment.appendChild(createFileItem(item, type, listElement)));
    listElement.appendChild(fragment);

    // 异步加载目录大小（".." 项不发请求）
    loadDirectorySizes(listElement);
    return fileList.length;
}

/** 用 createElement + textContent 构建文件项，防止文件名 XSS 注入 */
function createFileItem(item, type, listElement) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.path = item.path;
    if (item.isParent) el.classList.add('parent-dir');

    const icon = document.createElement('span');
    icon.className = item.type === 'directory' ? 'file-icon icon-dir' : 'file-icon icon-file';
    icon.innerHTML = item.isParent ? ICONS.back : (item.type === 'directory' ? ICONS.folder : ICONS.file);
    el.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.name;
    name.title = item.name;
    el.appendChild(name);

    // nlink 徽标：已有多个硬链接的文件显示 ×N
    if (!item.isParent && item.type === 'file' && item.nlink > 1) {
        const badge = document.createElement('span');
        badge.className = 'nlink-badge';
        badge.textContent = `×${item.nlink}`;
        badge.title = `该文件已有 ${item.nlink} 个硬链接`;
        el.appendChild(badge);
    }

    // 大小：父目录项直接显示 "--"，不参与异步统计
    const size = document.createElement('span');
    size.className = 'file-size';
    if (item.isParent) {
        size.textContent = '--';
    } else if (item.type === 'directory') {
        const dirSize = document.createElement('span');
        dirSize.className = 'dir-size';
        dirSize.dataset.path = item.path;
        dirSize.textContent = appState.dirSizeCache.get(item.path) || '计算中...';
        size.appendChild(dirSize);
    } else {
        size.textContent = item.size;
    }
    el.appendChild(size);

    // 源面板可选择（".." 除外），渲染时按路径 Set 比对选中态
    if (type === 'src' && !item.isParent) {
        if (appState.selectedPaths.has(item.path)) el.classList.add('selected');
        el.addEventListener('click', () => selectFile(item, el));
    }

    el.addEventListener('dblclick', () => {
        if (item.type === 'directory') enterDirectory(item, listElement);
    });

    return el;
}

function enterDirectory(item, listElement) {
    updateStatus(`正在进入目录: ${item.name}`, 'loading');
    loadPanel(item.path, listElement.id === 'src-list' ? 'src' : 'dst');
}

/** 异步统计目录大小（带缓存；不含 ".."，因其不渲染 .dir-size） */
async function loadDirectorySizes(listElement) {
    const spans = Array.from(listElement.querySelectorAll('.dir-size'));

    const tasks = spans.map(async (span) => {
        const dirPath = span.dataset.path;
        const cached = appState.dirSizeCache.get(dirPath);
        if (cached) {
            span.textContent = cached;
            return;
        }
        try {
            const response = await fetch(`/api/dir_size?path=${encodeURIComponent(dirPath)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const size = data || '未知';
            appState.dirSizeCache.set(dirPath, size);
            span.textContent = size;
        } catch {
            appState.dirSizeCache.set(dirPath, '未知');
            span.textContent = '未知';
        }
    });

    await Promise.allSettled(tasks);
}

/* =====================================================================
 * 选择管理（只跟踪源面板；以路径为标识，计数实时 DOM 校验）
 * ===================================================================== */
function selectFile(item, el) {
    if (appState.selectedPaths.has(item.path)) {
        appState.selectedPaths.delete(item.path);
        el.classList.remove('selected');
    } else {
        if (!appState.multiselectMode) clearAllSelections();
        appState.selectedPaths.add(item.path);
        el.classList.add('selected');
    }
    updateSelectionStatus(item.name);
}

/** 只清源面板的选择，绝不动目标面板 */
function clearAllSelections() {
    appState.selectedPaths.clear();
    srcList.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
}

/** 选中计数：基于实时 DOM 校验，剔除已被重渲染清掉的引用 */
function getSelectedCount() {
    if (appState.selectedPaths.size === 0) return 0;
    const renderedPaths = new Set();
    srcList.querySelectorAll('.file-item').forEach(el => renderedPaths.add(el.dataset.path));
    for (const p of Array.from(appState.selectedPaths)) {
        if (!renderedPaths.has(p)) appState.selectedPaths.delete(p);
    }
    return appState.selectedPaths.size;
}

function updateSelectionStatus(lastName) {
    const count = getSelectedCount();
    if (count === 0) {
        updateStatus('未选择任何文件', 'info');
    } else if (count === 1) {
        updateStatus(`已选择: ${lastName}`, 'info');
    } else {
        updateStatus(`已选择 ${count} 个文件(夹)`, 'info');
    }
}

/* =====================================================================
 * 加载 / 错误 / 返回默认目录
 * ===================================================================== */
function showLoading(listElement, message) {
    listElement.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'loading';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('div');
    text.textContent = message;
    wrap.append(spinner, text);
    listElement.appendChild(wrap);
}

/** 真正的加载失败才用 danger 色 */
function showLoadError(listElement, type, message) {
    listElement.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-directory error';

    const text = document.createElement('div');
    text.textContent = `加载失败：${message}`;

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary retry-default-btn';
    btn.textContent = '尝试返回默认目录';
    btn.addEventListener('click', () => retryDefaultDirectory(type));

    wrap.append(text, btn);
    listElement.appendChild(wrap);
}

async function retryDefaultDirectory(type) {
    try {
        updateStatus('正在返回默认目录...', 'loading');
        const dir = await fetchDefaultDir();
        document.getElementById(`${type}-path`).value = dir;
        await loadPanel(dir, type);
    } catch (error) {
        updateStatus(`返回默认目录失败: ${error.message}`, 'error');
    }
}

/* =====================================================================
 * 状态栏
 * ===================================================================== */
const STATUS_COLORS = {
    error: 'var(--danger)',
    success: 'var(--success)',
    loading: 'var(--warning)',
    warning: 'var(--warning)',
    info: 'var(--bronze)' // info 用铜棕色
};

function setStatusColor(type) {
    statusMessage.style.setProperty('--status-color', STATUS_COLORS[type] || STATUS_COLORS.info);
}

function updateStatus(message, type = 'info') {
    statusMessage.textContent = String(message);
    setStatusColor(type);
}
