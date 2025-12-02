// ==UserScript==
// @name         🍌 香蕉实验室 Token 抓取器
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  自动抓取 ListenHub/Banana Lab 登录信息并发送到本地服务
// @author       BananaLab
// @match        https://listenhub.ai/*
// @match        https://banana.listenhub.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// @connect      127.0.0.1
// @connect      api.listenhub.ai
// ==/UserScript==

(function() {
    'use strict';

    const SERVER_URL = 'http://localhost:3000';
    const CHECK_INTERVAL = 3000; // 3秒检查一次

    // 获取 Cookie（自动解码 URL 编码）
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) {
            let cookieValue = parts.pop().split(';').shift();
            // URL 解码
            try {
                cookieValue = decodeURIComponent(cookieValue);
            } catch (e) {}
            return cookieValue;
        }
        return null;
    }
    
    // 从 Cookie 中提取纯 Token（去掉 Bearer 前缀）
    function extractToken(cookieValue) {
        if (!cookieValue) return null;
        // 去掉 "Bearer " 前缀
        if (cookieValue.startsWith('Bearer ')) {
            return cookieValue.substring(7);
        }
        return cookieValue;
    }

    // 获取所有相关 Cookie
    function getAllCookies() {
        const cookies = {};
        document.cookie.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            if (name && value) {
                cookies[name] = value;
            }
        });
        return cookies;
    }

    // 获取用户信息（使用正确的 API 端点）
    async function getUserInfo(token) {
        try {
            const response = await fetch('https://api.listenhub.ai/api/v1/users/me', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Origin': 'https://banana.listenhub.ai',
                    'Referer': 'https://banana.listenhub.ai/'
                }
            });
            if (response.ok) {
                return await response.json();
            }
        } catch (e) {
            console.error('[Token抓取器] 获取用户信息失败:', e);
        }
        return null;
    }
    
    // 获取用户积分（使用正确的 API 端点）
    async function getCredits(token) {
        try {
            const response = await fetch('https://api.listenhub.ai/api/v1/users/subscription', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Origin': 'https://banana.listenhub.ai',
                    'Referer': 'https://banana.listenhub.ai/'
                }
            });
            if (response.ok) {
                const result = await response.json();
                if (result.code === 0 && result.data) {
                    return result.data.totalAvailableCredits || 0;
                }
            }
        } catch (e) {
            console.error('[Token抓取器] 获取积分失败:', e);
        }
        return 0;
    }
    
    // 获取签到状态
    async function getCheckinStatus(token) {
        try {
            const response = await fetch('https://api.listenhub.ai/api/v1/banana/checkin/status', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Origin': 'https://banana.listenhub.ai',
                    'Referer': 'https://banana.listenhub.ai/'
                }
            });
            if (response.ok) {
                const result = await response.json();
                return result.data || result;
            }
        } catch (e) {
            console.error('[Token抓取器] 获取签到状态失败:', e);
        }
        return null;
    }

    // 发送到本地服务器
    function sendToServer(data) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${SERVER_URL}/api/accounts/add`,
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify(data),
            onload: function(response) {
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.success) {
                        showNotification('✅ 账户已同步', `邮箱: ${data.email}\n积分: ${data.credits || '未知'}`);
                        // 记录已同步的 Token
                        GM_setValue('lastSyncedToken', data.token);
                    } else {
                        console.log('[Token抓取器] 同步失败:', result.message);
                    }
                } catch (e) {
                    console.error('[Token抓取器] 解析响应失败:', e);
                }
            },
            onerror: function(error) {
                console.error('[Token抓取器] 发送失败:', error);
                showNotification('❌ 同步失败', '无法连接到本地服务器\n请确保服务已启动');
            }
        });
    }

    // 显示通知
    function showNotification(title, text) {
        GM_notification({
            title: title,
            text: text,
            timeout: 5000
        });
    }

    // 创建悬浮按钮
    function createFloatingButton() {
        const btn = document.createElement('div');
        btn.id = 'banana-sync-btn';
        btn.innerHTML = '🍌';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(255, 107, 53, 0.4);
            z-index: 999999;
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        btn.title = '点击同步账户到香蕉实验室';
        
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.1)';
            btn.style.boxShadow = '0 6px 20px rgba(255, 107, 53, 0.6)';
        });
        
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = '0 4px 15px rgba(255, 107, 53, 0.4)';
        });
        
        btn.addEventListener('click', syncAccount);
        
        document.body.appendChild(btn);
        return btn;
    }

    // 创建状态面板
    function createStatusPanel() {
        const panel = document.createElement('div');
        panel.id = 'banana-status-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 80px;
            right: 20px;
            width: 280px;
            background: rgba(26, 26, 46, 0.95);
            border: 1px solid rgba(255, 154, 86, 0.3);
            border-radius: 12px;
            padding: 16px;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            z-index: 999998;
            display: none;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
        `;
        panel.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <span style="font-weight: 600; color: #ff9a56;">🍌 香蕉实验室</span>
                <span id="banana-close" style="cursor: pointer; opacity: 0.6;">✕</span>
            </div>
            <div id="banana-status">检测中...</div>
        `;
        
        document.body.appendChild(panel);
        
        panel.querySelector('#banana-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });
        
        return panel;
    }

    // 同步账户
    async function syncAccount() {
        const panel = document.getElementById('banana-status-panel');
        const statusDiv = document.getElementById('banana-status');
        
        panel.style.display = 'block';
        statusDiv.innerHTML = '<div style="color: #ffc107;">⏳ 正在获取账户信息...</div>';
        
        // 获取并解码 Token
        const rawToken = getCookie('app_access_token');
        const token = extractToken(rawToken);
        
        if (!token) {
            statusDiv.innerHTML = '<div style="color: #dc3545;">❌ 未检测到登录状态<br><small>请先登录 ListenHub 或 Banana Lab</small></div>';
            return;
        }
        
        console.log('[Token抓取器] 检测到 Token:', token.substring(0, 50) + '...');
        
        // 获取用户信息
        statusDiv.innerHTML = '<div style="color: #ffc107;">⏳ 正在获取用户信息...</div>';
        const userInfo = await getUserInfo(token);
        
        if (!userInfo || userInfo.code !== 0) {
            statusDiv.innerHTML = '<div style="color: #dc3545;">❌ Token 已失效<br><small>请重新登录</small></div>';
            return;
        }
        
        const userData = userInfo.data || userInfo;
        const email = userData.email || userData.nickname || 'unknown';
        
        // 获取积分（使用正确的 API）
        statusDiv.innerHTML = '<div style="color: #ffc107;">⏳ 正在获取积分信息...</div>';
        const credits = await getCredits(token);
        
        // 获取签到状态
        const checkinStatus = await getCheckinStatus(token);
        const isCheckedIn = checkinStatus?.checkedIn || checkinStatus?.checked_in || false;
        
        statusDiv.innerHTML = `
            <div style="margin-bottom: 8px;">
                <div style="color: #28a745;">✅ 已登录</div>
                <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div>📧 ${email}</div>
                    <div>💰 ${credits} 积分</div>
                    <div>📅 ${isCheckedIn ? '今日已签到' : '今日未签到'}</div>
                </div>
            </div>
            <div style="color: #ffc107;">⏳ 正在同步到本地服务...</div>
        `;
        
        // 获取所有 Cookie
        const cookies = getAllCookies();
        
        // 发送到服务器（发送纯 Token，不带 Bearer 前缀）
        sendToServer({
            email: email,
            token: token,
            cookies: cookies,
            credits: credits,
            userInfo: userData
        });
        
        setTimeout(() => {
            statusDiv.innerHTML = `
                <div style="margin-bottom: 8px;">
                    <div style="color: #28a745;">✅ 同步完成</div>
                    <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                        <div>📧 ${email}</div>
                        <div>💰 ${credits} 积分</div>
                        <div>📅 ${isCheckedIn ? '今日已签到' : '今日未签到'}</div>
                    </div>
                </div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 8px;">
                    打开 http://localhost:3000 查看
                </div>
            `;
        }, 1000);
    }

    // 自动检测登录状态
    function autoDetect() {
        const rawToken = getCookie('app_access_token');
        const token = extractToken(rawToken);
        const lastSynced = GM_getValue('lastSyncedToken', '');
        
        if (token && token !== lastSynced) {
            // 新的 Token，显示同步提示
            const btn = document.getElementById('banana-sync-btn');
            if (btn) {
                btn.style.animation = 'pulse 1s infinite';
                btn.title = '检测到新登录，点击同步账户';
            }
            console.log('[Token抓取器] 检测到新 Token，请点击 🍌 按钮同步');
        }
    }

    // 添加动画样式
    function addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.1); }
                100% { transform: scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    // 初始化
    function init() {
        console.log('[Token抓取器] 初始化...');
        addStyles();
        createFloatingButton();
        createStatusPanel();
        
        // 定期检测
        setInterval(autoDetect, CHECK_INTERVAL);
        autoDetect();
        
        console.log('[Token抓取器] 就绪！点击右下角 🍌 按钮同步账户');
    }

    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();