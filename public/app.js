// 香蕉实验室前端应用
const API_BASE = '';
let state = {
    accounts: [],
    images: [],
    currentImage: null,
    pagination: { total: 0, page: 1, pageSize: 20 },
    configs: [
        { id: 1, enabled: true, prompt: '', imageSize: '2K', aspectRatio: '1:1', referenceImageUrls: [] }
    ],
    nextConfigId: 2,
    concurrentTask: null,
    isBatchMode: false,
    selectedImages: new Set() // 存储格式: "id|accountId"
};

// 日志函数
function log(message, type = 'info', containerId = 'log-container') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const time = new Date().toLocaleTimeString();
    const item = document.createElement('div');
    item.className = `log-item ${type}`;
    item.textContent = `[${time}] ${message}`;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 100) container.removeChild(container.lastChild);
}

// 注册日志
function regLog(message, type = 'info') {
    log(message, type, 'register-log');
}

// API 请求封装
async function api(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers }
        });
        return response.json();
    } catch (e) {
        return { success: false, message: e.message };
    }
}

// 初始化
async function init() {
    log('正在初始化...', 'info');
    await loadStatus();
    await loadConfig();
    // await loadImages(); // 移除自动加载，改为点击 Tab 加载
    renderConfigs(); // 渲染初始配置
    renderAccountSelector(); // 渲染账户选择器
    setInterval(loadStatus, 30000);
    setInterval(checkConcurrentTaskStatus, 3000); // 轮询并发任务状态
    bindEvents();
    initTheme(); // 初始化主题
    log('初始化完成', 'success');
}

// 主题管理
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('theme-icon');
    if (icon) {
        icon.textContent = theme === 'dark' ? '🌙' : '☀️';
    }
}

// 加载状态
async function loadStatus() {
    const result = await api('/api/status');
    if (result.success) {
        const data = result.data;
        document.getElementById('status-dot').className = 'status-dot';
        document.getElementById('status-text').textContent = '已连接';
        document.getElementById('account-count').textContent = data.totalAccounts;
        document.getElementById('available-count').textContent = data.availableAccounts;
        document.getElementById('stat-accounts').textContent = data.totalAccounts;
        document.getElementById('stat-available').textContent = data.availableAccounts;
        document.getElementById('stat-images').textContent = data.totalImages;
        document.getElementById('stat-pending').textContent = state.concurrentTask && state.concurrentTask.status === 'running' ? '运行中' : '空闲';
        
        // 检查账户列表是否有变化，如果有则重新渲染选择器
        const oldAccounts = JSON.stringify(state.accounts.map(a => a.id).sort());
        const newAccounts = JSON.stringify(data.accounts.map(a => a.id).sort());
        state.accounts = data.accounts;
        
        renderAccounts();
        if (oldAccounts !== newAccounts) {
            renderAccountSelector();
        }
        
        // 更新心跳状态
        if (data.heartbeat) {
            const hb = data.heartbeat;
            const heartbeatEl = document.getElementById('heartbeat-status');
            if (heartbeatEl) {
                heartbeatEl.textContent = '运行中';
                heartbeatEl.title = `心跳间隔: ${hb.interval}秒`;
                heartbeatEl.style.color = '#4caf50';
            }
        }
    } else {
        document.getElementById('status-dot').className = 'status-dot danger';
        document.getElementById('status-text').textContent = '连接失败';
    }
}

// 加载配置
async function loadConfig() {
    const result = await api('/api/config');
    if (result.success) {
        const data = result.data;
        document.getElementById('moemail-url').value = data.moemail?.baseUrl || '';
        document.getElementById('moemail-domain').value = data.moemail?.domain || '';
        document.getElementById('browser-path').value = data.fingerprint?.browserPath || '';
    }
}

// 加载图片（使用正确的 API 响应结构）
async function loadImages(page = 1) {
    // 获取筛选参数
    const keyword = document.getElementById('filter-keyword')?.value.trim() || '';
    const accountId = document.getElementById('filter-account')?.value || '';
    const status = document.getElementById('filter-status')?.value || '';
    const aspectRatio = document.getElementById('filter-aspect-ratio')?.value || '';
    
    const queryParams = new URLSearchParams({
        page,
        pageSize: 50,
        keyword,
        accountId,
        status,
        aspectRatio
    });
    
    const result = await api(`/api/images?${queryParams.toString()}`);
    if (result.success) {
        // 使用正确的响应结构: result.data.images
        state.images = result.data.images || [];
        state.pagination = result.data.pagination || { total: 0, page: 1, pageSize: 50 };
        renderImages();
    }
}

// 渲染账户列表
function renderAccounts() {
    const container = document.getElementById('account-list');
    if (state.accounts.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👤</div><div>暂无账户</div></div>';
        return;
    }
    container.innerHTML = state.accounts.map(account => `
        <div class="account-item">
            <div class="account-info">
                <div class="account-email">${account.email}</div>
                <div class="account-meta">
                    <span class="account-credits ${account.credits < 15 ? 'low' : ''}">${account.credits} 积分</span>
                    <span>签到: ${account.lastCheckIn ? new Date(account.lastCheckIn).toLocaleDateString() : '未签到'}</span>
                </div>
            </div>
            <div class="account-actions">
                <button class="btn btn-sm btn-secondary" onclick="checkinAccount('${account.id}')">📅 签到</button>
                <button class="btn btn-sm btn-secondary" onclick="refreshAccount('${account.id}')">🔄</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAccount('${account.id}')">🗑️</button>
            </div>
        </div>
    `).join('');
}

// 渲染图片列表（支持状态显示）
function renderImages() {
    renderFilteredImages(state.images);
}

// 更新分页信息
function updatePagination() {
    const { total, page, pageSize } = state.pagination;
    const totalPages = Math.ceil(total / pageSize);
    
    // 如果有分页容器，更新它
    const paginationEl = document.getElementById('pagination-info');
    if (paginationEl) {
        paginationEl.textContent = `第 ${page} 页 / 共 ${totalPages} 页 (${total} 张图片)`;
    }
}

// 显示图片详情
async function showImage(id, accountId) {
    const result = await api(`/api/images/${id}?accountId=${accountId}`);
    if (result.success) {
        state.currentImage = result.data;
        const img = result.data;
        
        // 优先使用原图 URL，其次缩略图
        const displayUrl = img.imageUrl || img.thumbnailUrl || '';
        
        document.getElementById('modal-image').src = displayUrl;
        document.getElementById('modal-prompt').textContent = img.prompt || '无提示词';
        
        // 更新模态框中的详细信息
        const infoEl = document.getElementById('modal-details');
        if (infoEl) {
            infoEl.innerHTML = `
                <div class="detail-row"><span class="detail-label">状态:</span> <span class="detail-value status-${img.status}">${getStatusText(img.status)}</span></div>
                <div class="detail-row"><span class="detail-label">尺寸:</span> <span class="detail-value">${img.imageSize || '2K'}</span></div>
                <div class="detail-row"><span class="detail-label">比例:</span> <span class="detail-value">${img.aspectRatio || '1:1'}</span></div>
                <div class="detail-row"><span class="detail-label">可见性:</span> <span class="detail-value">${img.isPublic ? '🌐 公开' : '🔒 私密'}</span></div>
                <div class="detail-row"><span class="detail-label">账户:</span> <span class="detail-value">${img.accountEmail || '未知'}</span></div>
                <div class="detail-row"><span class="detail-label">创建时间:</span> <span class="detail-value">${formatTime(img.createdAt)}</span></div>
            `;
        }
        
        document.getElementById('image-modal').classList.add('active');
    } else {
        log(`获取图片详情失败: ${result.message}`, 'error');
    }
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        'pending': '⏳ 排队中',
        'processing': '🔄 生成中',
        'success': '✅ 已完成',
        'failed': '❌ 失败'
    };
    return statusMap[status] || status;
}

// 格式化时间
function formatTime(timestamp) {
    if (!timestamp) return '未知';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN');
}

function closeModal() {
    document.getElementById('image-modal').classList.remove('active');
}

function closeTokenModal() {
    document.getElementById('token-modal').classList.remove('active');
}

// 账户操作
async function checkinAccount(id) {
    log(`正在签到账户 ${id}...`);
    const result = await api(`/api/accounts/${id}/checkin`, { method: 'POST' });
    log(result.message, result.success ? 'success' : 'error');
    if (result.success) loadStatus();
}

async function refreshAccount(id) {
    const result = await api(`/api/accounts/${id}/refresh`, { method: 'POST' });
    if (result.success) loadStatus();
}

async function deleteAccount(id) {
    if (!confirm('确定要删除这个账户吗？')) return;
    const result = await api(`/api/accounts/${id}`, { method: 'DELETE' });
    log(result.message, result.success ? 'success' : 'error');
    if (result.success) loadStatus();
}

// 绑定事件
function bindEvents() {
    // Tab 切换
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
            
            // 懒加载图库
            if (tab.dataset.tab === 'gallery' && state.images.length === 0) {
                loadImages();
            }
        });
    });

    // 并发任务按钮
    document.getElementById('btn-start-concurrent').addEventListener('click', startConcurrentTask);
    document.getElementById('btn-stop-concurrent').addEventListener('click', stopConcurrentTask);
    document.getElementById('btn-add-config').addEventListener('click', addConfig);

    // 账户按钮
    document.getElementById('btn-auto-register').addEventListener('click', autoRegister);
    document.getElementById('btn-manual-register').addEventListener('click', manualRegister);
    document.getElementById('btn-add-token').addEventListener('click', () => {
        document.getElementById('token-modal').classList.add('active');
    });
    document.getElementById('btn-submit-token').addEventListener('click', submitToken);
    document.getElementById('btn-checkin-all').addEventListener('click', checkinAll);
    document.getElementById('btn-refresh-all').addEventListener('click', refreshAll);

    // 图片按钮
    document.getElementById('btn-refresh-images').addEventListener('click', () => loadImages());
    document.getElementById('btn-download').addEventListener('click', downloadImage);
    
    // 缩略图下载按钮（如果存在）
    const btnDownloadThumb = document.getElementById('btn-download-thumb');
    if (btnDownloadThumb) {
        btnDownloadThumb.addEventListener('click', downloadThumbnail);
    }
    
    // 图库筛选（如果存在）
    const filterAccount = document.getElementById('filter-account');
    const filterStatus = document.getElementById('filter-status');
    if (filterAccount) {
        filterAccount.addEventListener('change', filterImages);
        // 初始化账户筛选选项
        updateAccountFilter();
    }
    if (filterStatus) {
        filterStatus.addEventListener('change', filterImages);
    }

    // 批量操作
    const toggleBatch = document.getElementById('toggle-batch-mode');
    if (toggleBatch) {
        toggleBatch.addEventListener('change', (e) => toggleBatchMode(e.target.checked));
    }
    
    const selectAll = document.getElementById('select-all-images');
    if (selectAll) {
        selectAll.addEventListener('change', (e) => toggleSelectAll(e.target.checked));
    }
    
    const btnBatchDownload = document.getElementById('btn-batch-download');
    if (btnBatchDownload) {
        btnBatchDownload.addEventListener('click', batchDownload);
    }
    
    const btnBatchDelete = document.getElementById('btn-batch-delete');
    if (btnBatchDelete) {
        btnBatchDelete.addEventListener('click', batchDelete);
    }

    // 设置按钮
    document.getElementById('btn-save-config').addEventListener('click', saveConfig);
    
    // 主题切换
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

// 更新账户筛选选项
function updateAccountFilter() {
    const select = document.getElementById('filter-account');
    if (!select) return;
    
    // 保留第一个"所有账户"选项
    const firstOption = select.options[0];
    select.innerHTML = '';
    select.appendChild(firstOption);
    
    // 添加账户选项
    state.accounts.forEach(account => {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = `${account.email} (${account.credits}积分)`;
        select.appendChild(option);
    });
}

// 筛选图片
function filterImages() {
    const accountId = document.getElementById('filter-account')?.value || '';
    const status = document.getElementById('filter-status')?.value || '';
    
    let filtered = state.images;
    
    if (accountId) {
        filtered = filtered.filter(img => img.accountId === accountId);
    }
    
    if (status) {
        filtered = filtered.filter(img => img.status === status);
    }
    
    renderFilteredImages(filtered);
}

// 渲染筛选后的图片
function renderFilteredImages(images) {
    const container = document.getElementById('image-grid');
    if (images.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><div class="empty-state-icon">🔍</div><div>没有符合条件的图片</div></div>';
        return;
    }
    
    container.innerHTML = images.map(img => {
        const status = img.status || 'success';
        const isLoading = status === 'pending' || status === 'processing';
        const isFailed = status === 'failed';
        const imgSrc = img.thumbnailUrl || img.imageUrl || '';
        
        // 批量模式相关
        const key = `${img.id}|${img.accountId}`;
        const isSelected = state.selectedImages.has(key);
        const selectionClass = state.isBatchMode ? (isSelected ? 'selected' : '') : '';
        const clickHandler = state.isBatchMode
            ? `toggleImageSelection('${img.id}', '${img.accountId}')`
            : `showImage('${img.id}', '${img.accountId}')`;
        
        let statusBadge = '';
        if (isLoading) {
            statusBadge = '<div class="image-status loading">⏳ 生成中...</div>';
        } else if (isFailed) {
            statusBadge = '<div class="image-status failed">❌ 失败</div>';
        }
        
        const visibilityBadge = img.isPublic
            ? '<span class="visibility-badge public">🌐 公开</span>'
            : '<span class="visibility-badge private">🔒 私密</span>';
        
        // 选中标记
        const checkMark = state.isBatchMode && isSelected
            ? '<div class="selection-check">✓</div>'
            : '';
        
        // 错误处理图片
        const errorImg = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f8d7da'/><text x='50' y='50' font-size='40' text-anchor='middle' dy='.3em'>❌</text></svg>";

        return `
            <div class="image-card ${isLoading ? 'loading' : ''} ${isFailed ? 'failed' : ''} ${selectionClass}"
                 onclick="${clickHandler}"
                 data-status="${status}">
                ${checkMark}
                ${isLoading ? `
                    <div class="image-placeholder">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">生成中...</div>
                    </div>
                ` : isFailed ? `
                    <div class="image-placeholder failed">
                        <div class="failed-icon">❌</div>
                        <div class="failed-text">生成失败</div>
                    </div>
                ` : `
                    <img src="${imgSrc}"
                         alt="${img.prompt || ''}"
                         loading="lazy"
                         onerror="this.onerror=null; this.src='${errorImg}'; this.parentElement.classList.add('load-error');">
                `}
                ${statusBadge}
                <div class="image-card-overlay">
                    <div class="image-meta">
                        ${visibilityBadge}
                        <span class="image-size">${img.imageSize || '2K'}</span>
                        <span class="image-ratio">${img.aspectRatio || '1:1'}</span>
                    </div>
                    <div class="image-prompt" title="${img.prompt || ''}">
                        ${img.prompt || '无提示词'}
                    </div>
                    <div class="image-account">
                        👤 ${img.accountEmail || '未知账户'}
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // 更新分页信息
    updatePagination();
}

// 下载缩略图
function downloadThumbnail() {
    if (!state.currentImage) return;
    
    const url = state.currentImage.thumbnailUrl;
    
    if (url) {
        // 缩略图是公开的，可以直接下载
        const a = document.createElement('a');
        a.href = url;
        a.download = `banana-thumb-${state.currentImage.id || Date.now()}.webp`;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        log('开始下载缩略图...', 'success');
    } else {
        log('缩略图 URL 不可用', 'error');
    }
}

// ==================== 多配置管理 ====================

function renderConfigs() {
    const container = document.getElementById('configs-container');
    if (!container) return;
    
    container.innerHTML = state.configs.map((config, index) => `
        <div class="config-card ${config.enabled ? '' : 'disabled'}" data-id="${config.id}">
            <div class="config-header">
                <label class="config-enable">
                    <input type="checkbox" onchange="toggleConfig(${config.id}, this.checked)" ${config.enabled ? 'checked' : ''}>
                    <span>配置 #${index + 1}</span>
                </label>
                ${state.configs.length > 1 ? `<button class="btn-icon-danger" onclick="removeConfig(${config.id})">×</button>` : ''}
            </div>
            <div class="config-body">
                <div class="form-group">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <label class="form-label">参考图 (图生图)</label>
                        <span style="font-size: 12px; color: rgba(255,255,255,0.5);">${config.referenceImageUrls?.length || 0} 张</span>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="file" id="file-input-${config.id}" style="display: none;" accept="image/*" multiple onchange="handleImageUpload(${config.id}, this.files)">
                        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('file-input-${config.id}').click()">📁 上传图片</button>
                        ${config.referenceImageUrls?.length > 0 ? `<button class="btn btn-sm btn-danger" onclick="clearConfigImages(${config.id})">清空</button>` : ''}
                    </div>
                    ${config.referenceImageUrls?.length > 0 ? `
                        <div style="display: flex; gap: 8px; margin-top: 8px; overflow-x: auto; padding-bottom: 4px;">
                            ${config.referenceImageUrls.map(url => `<img src="${url}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2);">`).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="form-group">
                    <textarea class="input config-prompt" placeholder="输入提示词..." onchange="updateConfig(${config.id}, 'prompt', this.value)">${config.prompt || ''}</textarea>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <select class="input" onchange="updateConfig(${config.id}, 'imageSize', this.value)">
                            <option value="1K" ${config.imageSize === '1K' ? 'selected' : ''}>1K · HD</option>
                            <option value="2K" ${config.imageSize === '2K' ? 'selected' : ''}>2K · Ultra</option>
                            <option value="4K" ${config.imageSize === '4K' ? 'selected' : ''}>4K · Extreme</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <select class="input" onchange="updateConfig(${config.id}, 'aspectRatio', this.value)">
                            <option value="1:1" ${config.aspectRatio === '1:1' ? 'selected' : ''}>1:1 · 方形</option>
                            <option value="3:4" ${config.aspectRatio === '3:4' ? 'selected' : ''}>3:4 · 竖版</option>
                            <option value="4:3" ${config.aspectRatio === '4:3' ? 'selected' : ''}>4:3 · 横版</option>
                            <option value="16:9" ${config.aspectRatio === '16:9' ? 'selected' : ''}>16:9 · 宽屏</option>
                            <option value="9:16" ${config.aspectRatio === '9:16' ? 'selected' : ''}>9:16 · 竖屏</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

function addConfig() {
    state.configs.push({
        id: state.nextConfigId++,
        enabled: true,
        prompt: '',
        imageSize: '2K',
        aspectRatio: '1:1',
        referenceImageUrls: []
    });
    renderConfigs();
}

function removeConfig(id) {
    state.configs = state.configs.filter(c => c.id !== id);
    renderConfigs();
}

function toggleConfig(id, enabled) {
    const config = state.configs.find(c => c.id === id);
    if (config) config.enabled = enabled;
    renderConfigs();
}

function updateConfig(id, field, value) {
    const config = state.configs.find(c => c.id === id);
    if (config) config[field] = value;
}

function clearConfigImages(id) {
    const config = state.configs.find(c => c.id === id);
    if (config) {
        config.referenceImageUrls = [];
        renderConfigs();
    }
}

async function handleImageUpload(configId, files) {
    if (!files || files.length === 0) return;
    
    const config = state.configs.find(c => c.id === configId);
    if (!config) return;
    
    log(`正在上传 ${files.length} 张图片...`);
    
    for (const file of files) {
        try {
            // 1. 获取上传 URL
            const fileKey = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${file.name.split('.').pop()}`;
            const contentType = file.type || 'image/png';
            
            const urlResult = await api('/api/upload/url', {
                method: 'POST',
                body: JSON.stringify({ fileKey, contentType })
            });
            
            if (!urlResult.success) {
                log(`获取上传 URL 失败: ${urlResult.message}`, 'error');
                continue;
            }
            
            const { presignedUrl, fileUrl } = urlResult.data;
            
            // 2. 上传文件 (通过后端代理以避免 CORS)
            // 注意：这里我们使用 fetch 直接发送二进制数据
            const uploadResponse = await fetch(`/api/upload/proxy?uploadUrl=${encodeURIComponent(presignedUrl)}&contentType=${encodeURIComponent(contentType)}`, {
                method: 'PUT',
                body: file
            });
            
            if (!uploadResponse.ok) {
                const errText = await uploadResponse.text();
                throw new Error(`上传失败: ${errText}`);
            }
            
            // 3. 保存文件 URL
            if (!config.referenceImageUrls) config.referenceImageUrls = [];
            // 确保使用 fileUrl (不带签名的永久 URL)
            const finalUrl = fileUrl || presignedUrl.split('?')[0];
            config.referenceImageUrls.push(finalUrl);
            
            log(`图片上传成功: ${file.name}`, 'success');
            
        } catch (error) {
            log(`上传图片出错: ${error.message}`, 'error');
        }
    }
    
    renderConfigs();
}

// 将函数暴露给全局以便 HTML onclick 调用
window.toggleConfig = toggleConfig;
window.removeConfig = removeConfig;
window.updateConfig = updateConfig;
window.handleImageUpload = handleImageUpload;
window.clearConfigImages = clearConfigImages;

// ==================== 账户选择器 ====================

function renderAccountSelector() {
    const container = document.getElementById('account-selector');
    if (!container) return;
    
    if (state.accounts.length === 0) {
        container.innerHTML = '<div style="padding: 10px; color: rgba(255,255,255,0.5); font-size: 12px;">暂无可用账户</div>';
        return;
    }
    
    // 获取当前选中的账户（如果有）
    const currentSelected = Array.from(document.querySelectorAll('.account-checkbox:checked')).map(cb => cb.value);
    
    container.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 8px; max-height: 150px; overflow-y: auto; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 8px;">
            ${state.accounts.map(account => {
                const isAvailable = account.credits >= 15;
                const isChecked = currentSelected.includes(account.id);
                return `
                    <label class="account-select-item ${isAvailable ? '' : 'disabled'}" style="display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: rgba(255,255,255,0.1); border-radius: 4px; font-size: 12px; cursor: pointer; user-select: none;">
                        <input type="checkbox" class="account-checkbox" value="${account.id}" ${isChecked ? 'checked' : ''} ${isAvailable ? '' : 'disabled'}>
                        <span style="${isAvailable ? '' : 'color: rgba(255,255,255,0.4);'}">${account.email} (${account.credits})</span>
                    </label>
                `;
            }).join('')}
        </div>
        <div style="margin-top: 6px; font-size: 11px; color: rgba(255,255,255,0.5); display: flex; gap: 10px;">
            <span style="cursor: pointer; color: #ff9a56;" onclick="selectAllAccounts(true)">全选</span>
            <span style="cursor: pointer; color: #ff9a56;" onclick="selectAllAccounts(false)">全不选</span>
            <span>已选: <span id="selected-count">${currentSelected.length}</span></span>
        </div>
    `;
    
    // 绑定变更事件以更新计数
    document.querySelectorAll('.account-checkbox').forEach(cb => {
        cb.addEventListener('change', updateSelectedCount);
    });
}

function selectAllAccounts(select) {
    document.querySelectorAll('.account-checkbox:not(:disabled)').forEach(cb => {
        cb.checked = select;
    });
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = document.querySelectorAll('.account-checkbox:checked').length;
    const el = document.getElementById('selected-count');
    if (el) el.textContent = count;
}

window.selectAllAccounts = selectAllAccounts;

// ==================== 并发任务控制 ====================

async function startConcurrentTask() {
    const enabledConfigs = state.configs.filter(c => c.enabled && c.prompt.trim());
    
    if (enabledConfigs.length === 0) {
        log('请至少启用一个配置并填写提示词', 'error');
        return;
    }
    
    // 获取选中的账户
    const selectedAccountIds = Array.from(document.querySelectorAll('.account-checkbox:checked')).map(cb => cb.value);
    
    const concurrency = parseInt(document.getElementById('concurrency').value) || 1;
    const interval = parseInt(document.getElementById('interval').value) || 2000;
    const maxRounds = parseInt(document.getElementById('maxRounds').value) || 0;
    
    log(`正在启动并发任务... (配置数: ${enabledConfigs.length}, 账户数: ${selectedAccountIds.length || '自动'}, 并发: ${concurrency})`);
    
    const result = await api('/api/concurrent/start', {
        method: 'POST',
        body: JSON.stringify({
            configs: enabledConfigs,
            selectedAccountIds,
            concurrency,
            interval,
            maxRounds
        })
    });
    
    if (result.success) {
        log('并发任务已启动', 'success');
        updateTaskUI(true);
    } else {
        log(`启动失败: ${result.message}`, 'error');
    }
}

async function stopConcurrentTask() {
    const result = await api('/api/concurrent/stop', { method: 'POST' });
    if (result.success) {
        log('任务已停止', 'info');
        updateTaskUI(false);
    } else {
        log(`停止失败: ${result.message}`, 'error');
    }
}

async function checkConcurrentTaskStatus() {
    const result = await api('/api/concurrent/status');
    if (result.success && result.data.hasTask) {
        const task = result.data;
        state.concurrentTask = task;
        
        if (task.status === 'running') {
            updateTaskUI(true);
            // 更新统计信息
            const statsText = `运行中 | 轮次: ${task.currentRound} | 成功: ${task.generatedCount} | 失败: ${task.failedCount}`;
            log(statsText, 'info'); // 这里可以优化为只更新状态栏而不是一直打印日志
        } else {
            updateTaskUI(false);
            if (task.stopReason) {
                log(`任务已结束: ${task.stopReason}`, 'info');
            }
        }
    } else {
        updateTaskUI(false);
    }
}

function updateTaskUI(isRunning) {
    const startBtn = document.getElementById('btn-start-concurrent');
    const stopBtn = document.getElementById('btn-stop-concurrent');
    
    if (startBtn) startBtn.disabled = isRunning;
    if (stopBtn) stopBtn.disabled = !isRunning;
    
    // 禁用/启用配置编辑
    const inputs = document.querySelectorAll('#configs-container input, #configs-container textarea, #configs-container select, #configs-container button');
    inputs.forEach(el => el.disabled = isRunning);
}

// 自动注册
async function autoRegister() {
    const count = parseInt(document.getElementById('register-count').value) || 1;
    regLog(`正在自动注册 ${count} 个账户...`);
    log(`正在自动注册 ${count} 个账户...`);
    
    const result = await api('/api/accounts/auto-register', {
        method: 'POST',
        body: JSON.stringify({ count })
    });
    
    if (result.success) {
        const data = result.data;
        regLog(`注册完成: ${data.successCount}/${data.totalCount} 成功`, 'success');
        log(`注册完成: ${data.successCount}/${data.totalCount} 成功`, 'success');
        
        // 显示每个结果
        if (data.results) {
            data.results.forEach((r, i) => {
                if (r.success) {
                    regLog(`  ${i+1}. ✅ ${r.email} (${r.credits}积分)`, 'success');
                } else {
                    regLog(`  ${i+1}. ❌ ${r.message}`, 'error');
                }
            });
        }
        loadStatus();
    } else {
        regLog(`注册失败: ${result.message}`, 'error');
        log(`注册失败: ${result.message}`, 'error');
    }
}

// 手动注册
async function manualRegister() {
    regLog('正在启动浏览器无痕窗口...');
    log('正在启动浏览器无痕窗口...');
    const result = await api('/api/accounts/manual-register', { method: 'POST' });
    if (result.success) {
        regLog('浏览器已启动，请完成以下步骤：', 'success');
        regLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
        regLog('【推荐】安装油猴脚本自动同步：', 'info');
        regLog('1. 安装 Tampermonkey 扩展', 'info');
        regLog('2. 打开 token-grabber.user.js 安装脚本', 'info');
        regLog('3. 登录后点击页面右下角 🍌 按钮同步', 'info');
        regLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
        regLog('【手动方式】', 'info');
        regLog('1. 登录后按 F12 打开开发者工具', 'info');
        regLog('2. Application > Cookies > app_access_token', 'info');
        regLog('3. 复制值后点击"添加 Token"', 'info');
        log('浏览器已启动，请完成注册后添加 Token', 'success');
    } else {
        regLog(`启动失败: ${result.message}`, 'error');
        log(`启动失败: ${result.message}`, 'error');
    }
}

// 提交 Token
async function submitToken() {
    const email = document.getElementById('add-email').value.trim();
    const token = document.getElementById('add-token').value.trim();
    if (!token) { log('请输入 Token', 'error'); return; }
    
    const result = await api('/api/accounts/add', {
        method: 'POST',
        body: JSON.stringify({ email: email || 'unknown@manual.add', token })
    });
    
    if (result.success) {
        log('账户添加成功', 'success');
        closeTokenModal();
        document.getElementById('add-email').value = '';
        document.getElementById('add-token').value = '';
        loadStatus();
    } else {
        log(`添加失败: ${result.message}`, 'error');
    }
}

// 全部签到
async function checkinAll() {
    log('正在执行全部签到...');
    const result = await api('/api/accounts/checkin-all', { method: 'POST' });
    if (result.success) {
        log(`签到完成: ${result.data.success} 成功, ${result.data.failed} 失败`, 'success');
        loadStatus();
    } else {
        log(`签到失败: ${result.message}`, 'error');
    }
}

// 刷新全部积分
async function refreshAll() {
    log('正在刷新所有账户积分...');
    const result = await api('/api/accounts/refresh-all', { method: 'POST' });
    if (result.success) {
        log('积分刷新完成', 'success');
        loadStatus();
    } else {
        log(`刷新失败: ${result.message}`, 'error');
    }
}

// 下载图片（使用正确的字段名）
async function downloadImage(imageUrl = null, imageId = null) {
    // 如果没有传入参数，尝试使用当前查看的图片
    if (!imageUrl && state.currentImage) {
        imageUrl = state.currentImage.imageUrl || state.currentImage.thumbnailUrl;
        imageId = state.currentImage.id;
    }
    
    if (imageUrl) {
        // 使用代理下载避免跨域问题
        const proxyUrl = `/api/download?url=${encodeURIComponent(imageUrl)}`;
        
        // 创建下载链接
        const a = document.createElement('a');
        a.href = proxyUrl;
        a.download = `banana-${imageId || Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        if (!imageId) log('开始下载图片...', 'success'); // 批量下载时不刷屏
    } else {
        log('图片 URL 不可用', 'error');
    }
}

// 刷新图片 URL（当签名过期时）
async function refreshImageUrl(id, accountId) {
    const result = await api(`/api/images/${id}/refresh-url`, {
        method: 'POST',
        body: JSON.stringify({ accountId })
    });
    
    if (result.success) {
        log('图片 URL 已刷新', 'success');
        // 更新当前图片
        if (state.currentImage && state.currentImage.id === id) {
            state.currentImage.imageUrl = result.data.imageUrl;
            document.getElementById('modal-image').src = result.data.imageUrl;
        }
        return result.data;
    } else {
        log(`刷新失败: ${result.message}`, 'error');
        return null;
    }
}

// 保存配置
async function saveConfig() {
    const config = {
        moemail: {
            baseUrl: document.getElementById('moemail-url').value.trim(),
            apiKey: document.getElementById('moemail-key').value.trim(),
            domain: document.getElementById('moemail-domain').value.trim()
        },
        fingerprint: {
            browserPath: document.getElementById('browser-path').value.trim()
        },
        proxy: {
            url: document.getElementById('proxy-url').value.trim()
        }
    };
    
    const result = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify(config)
    });
    
    if (result.success) {
        log('配置保存成功', 'success');
    } else {
        log(`保存失败: ${result.message}`, 'error');
    }
}

// ==================== 批量操作逻辑 ====================

function toggleBatchMode(enabled) {
    state.isBatchMode = enabled;
    state.selectedImages.clear();
    
    const tools = document.getElementById('batch-tools');
    if (tools) tools.style.display = enabled ? 'flex' : 'none';
    
    // 重置全选框
    const selectAll = document.getElementById('select-all-images');
    if (selectAll) selectAll.checked = false;
    
    updateSelectedCountUI();
    renderImages(); // 重新渲染以更新点击事件和样式
}

function toggleImageSelection(id, accountId) {
    const key = `${id}|${accountId}`;
    if (state.selectedImages.has(key)) {
        state.selectedImages.delete(key);
    } else {
        state.selectedImages.add(key);
    }
    updateSelectedCountUI();
    renderImages(); // 重新渲染以更新选中样式
}

function toggleSelectAll(select) {
    // 获取当前显示的图片（可能是筛选后的）
    const currentImages = getCurrentDisplayedImages();
    
    currentImages.forEach(img => {
        const key = `${img.id}|${img.accountId}`;
        if (select) {
            state.selectedImages.add(key);
        } else {
            state.selectedImages.delete(key);
        }
    });
    
    updateSelectedCountUI();
    renderImages();
}

function getCurrentDisplayedImages() {
    // 这里简单起见，直接使用 state.images，因为 renderFilteredImages 也是基于它的
    // 如果有复杂的筛选逻辑，应该维护一个 filteredImages 状态
    // 目前 filterImages 函数是直接调用 renderFilteredImages，没有保存中间状态
    // 为了正确实现全选，我们需要重新运行一次筛选逻辑
    
    const accountId = document.getElementById('filter-account')?.value || '';
    const status = document.getElementById('filter-status')?.value || '';
    
    let filtered = state.images;
    
    if (accountId) {
        filtered = filtered.filter(img => img.accountId === accountId);
    }
    
    if (status) {
        filtered = filtered.filter(img => img.status === status);
    }
    
    return filtered;
}

function updateSelectedCountUI() {
    const el = document.getElementById('selected-count');
    if (el) el.textContent = `已选: ${state.selectedImages.size}`;
}

async function batchDownload() {
    if (state.selectedImages.size === 0) return;
    
    if (!confirm(`确定要下载选中的 ${state.selectedImages.size} 张图片吗？\n注意：浏览器可能会拦截多个下载弹窗，请允许。`)) return;
    
    log(`开始批量下载 ${state.selectedImages.size} 张图片...`);
    
    const selectedKeys = Array.from(state.selectedImages);
    let successCount = 0;
    
    for (const key of selectedKeys) {
        const [id, accountId] = key.split('|');
        const img = state.images.find(i => i.id === id && i.accountId === accountId);
        
        if (img) {
            const url = img.imageUrl || img.thumbnailUrl;
            if (url) {
                downloadImage(url, id);
                successCount++;
                // 稍微延迟一下，避免浏览器卡死或被拦截太快
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }
    
    log(`批量下载完成，共触发 ${successCount} 个下载任务`, 'success');
}

async function batchDelete() {
    if (state.selectedImages.size === 0) return;
    
    if (!confirm(`⚠️ 警告：确定要永久删除选中的 ${state.selectedImages.size} 张图片吗？\n此操作不可恢复！`)) return;
    
    log(`正在批量删除 ${state.selectedImages.size} 张图片...`);
    
    const items = Array.from(state.selectedImages).map(key => {
        const [id, accountId] = key.split('|');
        return { id, accountId };
    });
    
    const result = await api('/api/images/batch-delete-v2', {
        method: 'POST',
        body: JSON.stringify({ items })
    });
    
    if (result.success) {
        const { results } = result.data;
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        
        log(`批量删除完成: ${successCount} 成功, ${failCount} 失败`, successCount > 0 ? 'success' : 'error');
        
        // 清空选择并刷新列表
        state.selectedImages.clear();
        updateSelectedCountUI();
        
        // 退出批量模式
        document.getElementById('toggle-batch-mode').checked = false;
        toggleBatchMode(false);
        
        loadImages(state.pagination.page); // 刷新当前页
    } else {
        log(`批量删除失败: ${result.message}`, 'error');
    }
}

// 将函数暴露给全局
window.toggleBatchMode = toggleBatchMode;
window.toggleImageSelection = toggleImageSelection;
window.toggleSelectAll = toggleSelectAll;

// 启动应用
document.addEventListener('DOMContentLoaded', init);