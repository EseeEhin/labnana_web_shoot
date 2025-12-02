#!/usr/bin/env node
/**
 * 香蕉实验室独立前端 - 后端服务
 * 
 * 功能：
 * 1. 账户管理（手动/自动注册、积分监控、签到）
 * 2. 图片生成（智能账户选择、任务队列）
 * 3. 图片管理（预览、下载）
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 心跳配置
const HEARTBEAT_INTERVAL = 60000; // 1分钟检查一次
const CREDITS_REFRESH_INTERVAL = 300000; // 5分钟刷新一次积分
const AUTO_CHECKIN_HOUR = 8; // 每天8点自动签到

// 并发任务配置
const TASK_CREDITS_CHECK_INTERVAL = 5000; // 5秒检测一次积分
const MIN_CREDITS_REQUIRED = 15; // 最低积分要求

// ==================== 配置 ====================
const API = {
    LISTENHUB: 'https://listenhub.ai/api',
    BANANA: 'https://api.listenhub.ai/api/v1/banana',
    USERS: 'https://api.listenhub.ai/api/v1/users'  // 用户 API（积分等）
};

// ==================== 数据存储 ====================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('加载数据失败:', e.message);
    }
    return {
        accounts: [],
        tasks: [],
        images: []
    };
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('加载配置失败:', e.message);
    }
    return {
        moemail: {
            baseUrl: '',
            apiKey: ''
        },
        fingerprint: {
            browserPath: ''
        },
        generation: {
            defaultPrompt: '',
            defaultSize: '2K',
            defaultRatio: '1:1',
            interval: 2000
        }
    };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

let data = loadData();
let config = loadConfig();

// ==================== 并发任务管理 ====================
// 当前运行的并发任务
let currentConcurrentTask = null;

class ConcurrentTask {
    constructor(options) {
        this.id = Date.now().toString();
        this.configs = options.configs || []; // 多配置列表
        this.selectedAccountIds = options.selectedAccountIds || []; // 指定的账户ID
        this.concurrency = options.concurrency || 1; // 并发账户数（未指定账户时使用）
        this.interval = options.interval || 2000; // 请求间隔（毫秒）
        this.maxRounds = options.maxRounds || 0; // 最大轮次（0=无限）
        
        this.status = 'running'; // running, stopped, completed
        this.participatingAccounts = []; // 参与的账户池
        
        this.generatedCount = 0; // 已生成数量
        this.failedCount = 0; // 失败数量
        this.configIndex = 0; // 当前配置索引（用于轮询）
        this.results = []; // 生成结果
        this.startTime = new Date().toISOString();
        this.stopReason = null;
        
        this.creditsCheckTimer = null;
    }
    
    // 选择参与的账户
    selectAccounts() {
        // 1. 筛选所有积分充足且有Token的账户
        let available = data.accounts.filter(a => a.credits >= MIN_CREDITS_REQUIRED && a.token);
        
        // 2. 如果指定了账户，只从指定的里面选
        if (this.selectedAccountIds.length > 0) {
            available = available.filter(a => this.selectedAccountIds.includes(a.id));
            this.participatingAccounts = available;
        } else {
            // 3. 如果没指定，随机选 concurrency 个
            // 随机打乱
            available.sort(() => Math.random() - 0.5);
            this.participatingAccounts = available.slice(0, this.concurrency);
        }
        
        return this.participatingAccounts.length;
    }
    
    // 刷新参与账户的积分
    async refreshCredits() {
        console.log(`[并发任务 ${this.id}] 刷新参与账户积分...`);
        let availableCount = 0;
        
        // 只刷新参与任务的账户
        for (const account of this.participatingAccounts) {
            try {
                const credits = await getCredits(account.token);
                if (credits !== null) {
                    const oldCredits = account.credits;
                    account.credits = credits;
                    
                    // 同步更新 data.accounts 中的积分
                    const dataAccount = data.accounts.find(a => a.id === account.id);
                    if (dataAccount) {
                        dataAccount.credits = credits;
                    }
                    
                    if (oldCredits !== credits) {
                        console.log(`[并发任务] ${account.email}: 更新账户积分，实际积分为：${credits}`);
                    }
                    
                    if (credits >= MIN_CREDITS_REQUIRED) {
                        availableCount++;
                    }
                }
            } catch (e) {
                console.error(`[并发任务] 刷新 ${account.email} 积分失败:`, e.message);
            }
        }
        
        saveData(data);
        
        // 检查是否所有账户积分都不足
        if (availableCount === 0) {
            console.log(`[并发任务 ${this.id}] 所有参与账户积分不足，自动停止`);
            this.stop('所有参与账户积分不足');
            return false;
        }
        
        return true;
    }
    
    // 账户工作线程
    async runAccountWorker(account) {
        console.log(`[并发任务 ${this.id}] 账户 ${account.email} 工作线程启动`);
        
        while (this.status === 'running') {
            // 检查积分
            if (account.credits < MIN_CREDITS_REQUIRED) {
                console.log(`[并发任务] 账户 ${account.email} 积分不足，暂停使用`);
                await new Promise(r => setTimeout(r, 5000)); // 等待5秒再检查
                continue;
            }
            
            // 轮询获取配置
            const config = this.configs[this.configIndex % this.configs.length];
            this.configIndex++; // 指向下一个配置
            
            // 执行生成
            await this.generateForConfig(config, account);
            
            // 检查最大轮次（这里简单用生成总数近似判断，或者不判断，由外部控制）
            if (this.maxRounds > 0 && this.generatedCount >= this.maxRounds * this.configs.length) {
                this.stop('达到最大生成数量');
                break;
            }
            
            // 等待间隔
            if (this.status === 'running') {
                await new Promise(r => setTimeout(r, this.interval));
            }
        }
    }
    
    // 执行单个配置的生成
    async generateForConfig(config, account) {
        try {
            console.log(`[并发任务 ${this.id}] 账户 ${account.email} -> 配置 #${config.id}`);
            
            // 扣除预估积分
            account.credits -= 15;
            
            let result = await generateImage(account.token, {
                prompt: config.prompt,
                imageSize: config.imageSize,
                aspectRatio: config.aspectRatio,
                referenceImageUrls: config.referenceImageUrls
            });
            
            // 检查 API 响应
            // 成功响应格式: { code: 0, data: { id: "xxx", status: "queued", ... } }
            // 失败响应格式: { code: -1, message: "错误信息" }
            
            // 首先检查是否有错误码
            if (result.code !== undefined && result.code !== 0) {
                // 处理 429 限流 (code 29998)
                if (result.code === 29998) {
                    console.log(`[并发任务 ${this.id}] 触发429限流，休眠3秒后重试...`);
                    await new Promise(r => setTimeout(r, 3000));
                    // 简单的重试逻辑：再次调用 API
                    const retryResult = await generateImage(account.token, {
                        prompt: config.prompt,
                        imageSize: config.imageSize,
                        aspectRatio: config.aspectRatio,
                        referenceImageUrls: config.referenceImageUrls
                    });
                    
                    // 如果重试成功，覆盖 result 并继续
                    if (retryResult.code === 0 || retryResult.code === undefined) {
                        console.log(`[并发任务 ${this.id}] 重试成功！`);
                        result = retryResult; // 覆盖 result，让后续逻辑处理成功情况
                    } else {
                        console.log(`[并发任务 ${this.id}] 重试依然失败: ${retryResult.message}`);
                        // 重试失败，result 保持原样，继续走下面的失败流程
                    }
                }
            }

            // 再次检查（因为可能重试成功了）
            if (result.code !== undefined && result.code !== 0) {
                this.failedCount++;
                const errorMsg = result.message || `API错误码: ${result.code}`;
                console.log(`[并发任务 ${this.id}] 生成失败: ${errorMsg}`);
                
                if (errorMsg.includes('积分') || errorMsg.includes('credit') || errorMsg.includes('insufficient')) {
                    account.credits = 0;
                }
                
                this.results.push({
                    success: false,
                    message: errorMsg,
                    configId: config.id,
                    accountEmail: account.email,
                    timestamp: new Date().toISOString()
                });
                return { success: false, message: errorMsg };
            }
            
            // 尝试多种方式获取任务ID（API 返回 imageId）
            const taskId = result.data?.imageId || result.data?.id || result.data?.taskId || result.id || result.taskId || result.imageId;
            
            if (taskId) {
                this.generatedCount++;
                const genResult = {
                    success: true,
                    taskId,
                    configId: config.id,
                    accountEmail: account.email,
                    accountId: account.id,
                    timestamp: new Date().toISOString()
                };
                this.results.push(genResult);
                
                // 记录到全局任务列表
                data.tasks.push({
                    id: taskId,
                    accountId: account.id,
                    prompt: config.prompt,
                    concurrentTaskId: this.id,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                });
                saveData(data);
                
                console.log(`[并发任务 ${this.id}] 生成成功 #${this.generatedCount}, taskId: ${taskId}`);
                return genResult;
            } else {
                this.failedCount++;
                const errorMsg = result.message || result.error || `无法获取taskId，响应: ${JSON.stringify(result).substring(0, 200)}`;
                console.log(`[并发任务 ${this.id}] 生成失败: ${errorMsg}`);
                
                this.results.push({
                    success: false,
                    message: errorMsg,
                    configId: config.id,
                    accountEmail: account.email,
                    timestamp: new Date().toISOString()
                });
                return { success: false, message: errorMsg };
            }
        } catch (error) {
            this.failedCount++;
            console.error(`[并发任务 ${this.id}] 生成错误:`, error.message);
            this.results.push({
                success: false,
                message: error.message,
                configId: config.id,
                timestamp: new Date().toISOString()
            });
            return { success: false, message: error.message };
        }
    }
    
    // 启动任务
    async start() {
        const accountCount = this.selectAccounts();
        if (accountCount === 0) {
            this.status = 'stopped';
            this.stopReason = '没有可用账户（积分不足）';
            return { success: false, message: this.stopReason };
        }
        
        console.log(`[并发任务 ${this.id}] 启动，参与账户: ${accountCount}，配置数: ${this.configs.length}`);
        
        // 启动积分检测定时器
        this.creditsCheckTimer = setInterval(async () => {
            if (this.status === 'running') {
                await this.refreshCredits();
            }
        }, 10000);
        
        // 为每个参与账户启动一个独立的工作线程
        this.participatingAccounts.forEach(account => {
            this.runAccountWorker(account);
        });
        
        return {
            success: true,
            taskId: this.id,
            participatingAccounts: this.participatingAccounts.map(a => ({
                id: a.id,
                email: a.email,
                credits: a.credits
            }))
        };
    }
    
    // 停止任务
    stop(reason = '手动停止') {
        if (this.status !== 'running') return;
        
        this.status = 'stopped';
        this.stopReason = reason;
        
        if (this.creditsCheckTimer) {
            clearInterval(this.creditsCheckTimer);
            this.creditsCheckTimer = null;
        }
        
        console.log(`[并发任务 ${this.id}] 已停止: ${reason}`);
        console.log(`[并发任务 ${this.id}] 统计: 成功 ${this.generatedCount}, 失败 ${this.failedCount}`);
    }
    
    // 获取状态
    getStatus() {
        return {
            id: this.id,
            status: this.status,
            configs: this.configs,
            concurrency: this.concurrency,
            interval: this.interval,
            generatedCount: this.generatedCount,
            failedCount: this.failedCount,
            startTime: this.startTime,
            stopReason: this.stopReason,
            participatingAccounts: this.participatingAccounts.map(a => ({
                id: a.id,
                email: a.email,
                credits: a.credits,
                available: a.credits >= MIN_CREDITS_REQUIRED
            })),
            recentResults: this.results.slice(-10) // 最近10条结果
        };
    }
}

// ==================== MoEmail 客户端 ====================
class MoeMailClient {
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl.replace(/\/$/, '') + '/api';
        this.apiKey = apiKey;
    }

    async request(method, endpoint, body = null) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时
        
        try {
            const options = {
                method,
                headers: {
                    'X-API-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            };
            if (body) {
                options.body = JSON.stringify(body);
            }
            const response = await fetch(`${this.baseUrl}${endpoint}`, options);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`MoEmail API 错误: ${response.status} - ${text}`);
            }
            return response.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    async generateEmail(name = null, domain = null) {
        if (!name) {
            name = Math.random().toString(36).substring(2, 12);
        }
        return this.request('POST', '/emails/generate', {
            name,
            domain: domain || 'isha01.ggff.net',
            expiryTime: 3600000
        });
    }

    async getMessages(emailId) {
        const data = await this.request('GET', `/emails/${emailId}`);
        return data.messages || [];
    }

    async getMessageDetail(emailId, messageId) {
        const data = await this.request('GET', `/emails/${emailId}/${messageId}`);
        // MoEmail API 返回 { message: { content, html, ... } }
        // 需要提取 message 对象并规范化字段名
        const msg = data.message || data;
        return {
            id: msg.id,
            from: msg.from_address || msg.from,
            to: msg.to_address || msg.to,
            subject: msg.subject,
            text: msg.content || msg.text,  // MoEmail 用 content 而不是 text
            html: msg.html,
            receivedAt: msg.received_at || msg.receivedAt
        };
    }

    async waitForEmail(emailId, timeout = 120000, interval = 5000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const messages = await this.getMessages(emailId);
            if (messages.length > 0) {
                return this.getMessageDetail(emailId, messages[0].id);
            }
            await new Promise(r => setTimeout(r, interval));
        }
        return null;
    }
}

// ==================== ListenHub API ====================
// 正确的 API 端点（通过浏览器抓包确认）
const LISTENHUB_API = {
    SEND_CODE: 'https://listenhub.ai/api/listenhub/v1/email',
    VERIFY_CODE: 'https://listenhub.ai/api/listenhub/v1/auth/signin/email-code'
};

// 带超时和重试的 fetch 函数
async function fetchWithRetry(url, options, maxRetries = 3, timeout = 30000) {
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            console.log(`[Fetch] 第 ${i + 1}/${maxRetries} 次请求失败:`, error.message);
            
            if (i === maxRetries - 1) {
                throw error;
            }
            
            // 等待后重试
            await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
}

async function sendVerificationCode(email) {
    console.log(`[ListenHub] 发送验证码到: ${email}`);
    try {
        const response = await fetchWithRetry(LISTENHUB_API.SEND_CODE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://listenhub.ai',
                'Referer': 'https://listenhub.ai/zh/login',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({ email, type: 'signin' })
        });
        const text = await response.text();
        console.log(`[ListenHub] send-code 响应: ${text}`);
        try {
            const result = JSON.parse(text);
            // code=0 表示成功
            return {
                success: result.code === 0,
                ...result
            };
        } catch (e) {
            return { success: response.ok, raw: text };
        }
    } catch (error) {
        console.error(`[ListenHub] 发送验证码失败:`, error.message);
        return { success: false, error: error.message };
    }
}

async function verifyCode(email, code) {
    console.log(`[ListenHub] 验证码验证: ${email}, code: ${code}`);
    try {
        const response = await fetchWithRetry(LISTENHUB_API.VERIFY_CODE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://listenhub.ai',
                'Referer': 'https://listenhub.ai/zh/login/email-verification',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({ email, code })
        });
        const text = await response.text();
        console.log(`[ListenHub] verify 响应: ${text}`);
        try {
            const result = JSON.parse(text);
            // 成功时会返回 token 信息
            if (result.code === 0 && result.data) {
                return {
                    success: true,
                    accessToken: result.data.accessToken || result.data.token,
                    refreshToken: result.data.refreshToken,
                    user: result.data.user,
                    ...result.data
                };
            }
            return { success: false, ...result };
        } catch (e) {
            return { success: false, raw: text };
        }
    } catch (error) {
        console.error(`[ListenHub] 验证码验证失败:`, error.message);
        return { success: false, error: error.message };
    }
}

// ==================== Banana API ====================

// 获取用户积分 - 使用 /users/subscription 端点
// 返回 totalAvailableCredits 字段
async function getCredits(token) {
    try {
        const response = await fetch(`${API.USERS}/subscription`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Origin': 'https://banana.listenhub.ai',
                'Referer': 'https://banana.listenhub.ai/'
            }
        });
        if (!response.ok) {
            console.log(`[积分] 获取失败: ${response.status}`);
            return null;
        }
        const result = await response.json();
        console.log(`[积分] 响应:`, JSON.stringify(result).substring(0, 300));
        
        // 积分在 data.totalAvailableCredits
        if (result.code === 0 && result.data) {
            return result.data.totalAvailableCredits ?? 0;
        }
        return result.totalAvailableCredits ?? 0;
    } catch (e) {
        console.error(`[积分] 错误:`, e.message);
        return null;
    }
}

// 获取签到状态
async function getCheckinStatus(token) {
    try {
        const response = await fetch(`${API.BANANA}/checkin/status`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Origin': 'https://banana.listenhub.ai',
                'Referer': 'https://banana.listenhub.ai/'
            }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.data || data;
    } catch (e) {
        return null;
    }
}

// 执行签到 - 使用 /banana/checkin 端点（注意没有连字符）
async function checkIn(token) {
    try {
        // 先检查签到状态
        const status = await getCheckinStatus(token);
        if (status?.checkedIn || status?.checked_in) {
            console.log(`[签到] 今日已签到`);
            return false; // 已签到
        }
        
        const response = await fetch(`${API.BANANA}/checkin`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Origin': 'https://banana.listenhub.ai',
                'Referer': 'https://banana.listenhub.ai/'
            }
        });
        
        const text = await response.text();
        console.log(`[签到] 响应: ${text}`);
        
        if (!response.ok) {
            console.log(`[签到] 失败: ${response.status}`);
            return false;
        }
        
        try {
            const data = JSON.parse(text);
            return data.code === 0 || response.ok;
        } catch {
            return response.ok;
        }
    } catch (e) {
        console.error(`[签到] 错误:`, e.message);
        return false;
    }
}

async function generateImage(token, params) {
    const body = {
        prompt: params.prompt,
        imageSize: params.imageSize || '2K',
        aspectRatio: params.aspectRatio || '1:1',
        isPublic: false
    };
    if (params.referenceImageUrls?.length > 0) {
        body.referenceImageUrls = params.referenceImageUrls;
    }
    
    console.log(`[生图API] 请求参数:`, JSON.stringify(body));
    
    const response = await fetch(`${API.BANANA}/images`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://banana.listenhub.ai',
            'Referer': 'https://banana.listenhub.ai/'
        },
        body: JSON.stringify(body)
    });
    
    const result = await response.json();
    console.log(`[生图API] 响应状态: ${response.status}, 内容:`, JSON.stringify(result).substring(0, 500));
    
    return result;
}

// 获取图库列表 - 使用正确的 API 参数
// 响应结构: { code: 0, data: { images: [...], pagination: { total, page, pageSize } } }
async function getImageList(token, page = 1, pageSize = 16) {
    try {
        const response = await fetch(`${API.BANANA}/images?page=${page}&pageSize=${pageSize}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Origin': 'https://banana.listenhub.ai',
                'Referer': 'https://banana.listenhub.ai/'
            }
        });
        
        if (!response.ok) {
            console.log(`[图库] 获取失败: ${response.status}`);
            return { code: -1, data: { images: [], pagination: { total: 0 } } };
        }
        
        const result = await response.json();
        return result;
    } catch (e) {
        console.error(`[图库] 错误:`, e.message);
        return { code: -1, data: { images: [], pagination: { total: 0 } } };
    }
}

async function getImageDetail(token, imageId) {
    const response = await fetch(`${API.BANANA}/images/${imageId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return response.json();
}

// ==================== 工具函数 ====================
function extractVerificationCode(text) {
    console.log(`[验证码提取] 原始文本长度: ${text?.length || 0}`);
    
    if (!text) return null;
    
    // ListenHub 邮件格式：验证码单独一行，是4位数字
    // 邮件内容示例:
    // "...Please use the following verification code to complete the login process:
    //
    // 1127
    //
    // This verification code will expire..."
    
    const patterns = [
        // 匹配 "login process:" 后面的4位数字（可能有换行）
        /login process[:\s]*[\r\n]+\s*(\d{4})/i,
        // 匹配 "verification code" 后面的4位数字
        /verification code[:\s]*[\r\n]*\s*(\d{4})/i,
        // 匹配单独一行的4位数字（前后都是换行或空白）
        /[\r\n]\s*(\d{4})\s*[\r\n]/,
        // 匹配 "code:" 后面的数字
        /code[:\s]+(\d{4,8})/i,
        // 最后尝试匹配任意4位数字
        /\b(\d{4})\b/
    ];
    
    for (let i = 0; i < patterns.length; i++) {
        const match = text.match(patterns[i]);
        if (match) {
            console.log(`[验证码提取] 使用模式 ${i + 1} 匹配到: ${match[1]}`);
            return match[1];
        }
    }
    
    console.log(`[验证码提取] 未能匹配到验证码`);
    return null;
}

function getAvailableAccount() {
    // 获取积分 >= 15 的账户
    const available = data.accounts.filter(a => a.credits >= 15 && a.token);
    if (available.length === 0) return null;
    // 轮询选择
    return available[Math.floor(Math.random() * available.length)];
}

// ==================== API 路由 ====================

// 获取系统状态
app.get('/api/status', (req, res) => {
    const accounts = data.accounts.map(a => ({
        id: a.id,
        email: a.email,
        credits: a.credits,
        hasToken: !!a.token,
        hasCookies: !!a.cookies && Object.keys(a.cookies).length > 0,
        lastCheckIn: a.lastCheckIn,
        createdAt: a.createdAt
    }));
    
    const now = Date.now();
    const nextCreditsRefresh = Math.max(0, CREDITS_REFRESH_INTERVAL - (now - lastCreditsRefresh));
    const today = new Date().toISOString().split('T')[0];
    
    res.json({
        success: true,
        data: {
            accounts,
            totalAccounts: accounts.length,
            availableAccounts: accounts.filter(a => a.credits >= 15).length,
            pendingTasks: data.tasks.filter(t => t.status === 'pending').length,
            totalImages: data.images.length,
            heartbeat: {
                lastCreditsRefresh: lastCreditsRefresh ? new Date(lastCreditsRefresh).toISOString() : null,
                nextCreditsRefresh: Math.round(nextCreditsRefresh / 1000),
                lastAutoCheckin: lastAutoCheckin,
                todayCheckedIn: lastAutoCheckin === today
            }
        }
    });
});

// 获取配置
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        data: {
            moemail: {
                baseUrl: config.moemail?.baseUrl || '',
                hasApiKey: !!config.moemail?.apiKey
            },
            fingerprint: config.fingerprint || {},
            generation: config.generation || {}
        }
    });
});

// 更新配置
app.post('/api/config', (req, res) => {
    const { moemail, fingerprint, generation } = req.body;
    
    // 重新加载配置以确保最新
    config = loadConfig();
    
    if (moemail) {
        config.moemail = { ...config.moemail, ...moemail };
    }
    if (fingerprint) {
        config.fingerprint = { ...config.fingerprint, ...fingerprint };
    }
    if (generation) {
        config.generation = { ...config.generation, ...generation };
    }
    
    saveConfig(config);
    
    // 更新内存中的配置
    console.log('[配置] 已更新:', JSON.stringify(config.moemail, null, 2));
    
    res.json({ success: true, message: '配置已保存' });
});

// 手动注册 - 启动默认浏览器无痕窗口
app.post('/api/accounts/manual-register', (req, res) => {
    const url = 'https://listenhub.ai/zh/login';
    
    // 根据操作系统选择命令
    let command;
    if (process.platform === 'win32') {
        // Windows: 尝试 Edge 无痕模式，如果失败则用默认浏览器
        command = `start msedge --inprivate "${url}" || start chrome --incognito "${url}" || start "" "${url}"`;
    } else if (process.platform === 'darwin') {
        // macOS
        command = `open -na "Google Chrome" --args --incognito "${url}" || open "${url}"`;
    } else {
        // Linux
        command = `google-chrome --incognito "${url}" || xdg-open "${url}"`;
    }
    
    exec(command, { shell: true }, (error) => {
        if (error) {
            console.log('[手动注册] 启动浏览器错误:', error.message);
            // 即使有错误也可能成功打开了浏览器
        }
    });
    
    res.json({
        success: true,
        message: '已启动浏览器无痕窗口，请完成注册后手动添加 Token',
        url
    });
});

// 手动添加账户
app.post('/api/accounts/add', async (req, res) => {
    const { email, token, cookies, credits: providedCredits, userInfo } = req.body;
    
    if (!token) {
        return res.json({ success: false, message: 'Token 不能为空' });
    }
    
    // 检查是否已存在相同 Token 的账户
    const existingIndex = data.accounts.findIndex(a => a.token === token);
    if (existingIndex !== -1) {
        // 更新现有账户
        const existing = data.accounts[existingIndex];
        existing.cookies = cookies || existing.cookies;
        existing.userInfo = userInfo || existing.userInfo;
        if (providedCredits !== undefined) {
            existing.credits = providedCredits;
        }
        saveData(data);
        console.log(`[账户] 更新已有账户: ${existing.email}`);
        return res.json({
            success: true,
            message: '账户已更新',
            data: { id: existing.id, email: existing.email, credits: existing.credits }
        });
    }
    
    // 验证 Token 并获取积分
    let credits = providedCredits;
    if (credits === undefined) {
        credits = await getCredits(token);
        if (credits === null) {
            return res.json({ success: false, message: 'Token 无效或已过期' });
        }
    }
    
    // 尝试签到
    await checkIn(token);
    
    const account = {
        id: Date.now().toString(),
        email: email || userInfo?.email || userInfo?.nickname || 'unknown',
        token,
        cookies: cookies || {},
        credits,
        userInfo: userInfo || {},
        lastCheckIn: new Date().toISOString(),
        createdAt: new Date().toISOString()
    };
    
    data.accounts.push(account);
    saveData(data);
    
    console.log(`[账户] 新增账户: ${account.email}, 积分: ${credits}`);
    
    res.json({
        success: true,
        message: '账户添加成功',
        data: { id: account.id, email: account.email, credits }
    });
});

// 自动注册（支持批量）
app.post('/api/accounts/auto-register', async (req, res) => {
    const { count = 1 } = req.body;
    
    // 重新加载配置以确保最新
    config = loadConfig();
    
    if (!config.moemail?.baseUrl || !config.moemail?.apiKey) {
        return res.json({ success: false, message: '请先配置 MoEmail' });
    }
    
    const results = [];
    const registerCount = Math.min(Math.max(1, parseInt(count) || 1), 10); // 最多10个
    
    for (let i = 0; i < registerCount; i++) {
        console.log(`[自动注册] 开始注册第 ${i + 1}/${registerCount} 个账户...`);
        
        try {
            const result = await registerOneAccount();
            results.push(result);
            
            if (result.success) {
                console.log(`[自动注册] 第 ${i + 1} 个成功: ${result.email}`);
            } else {
                console.log(`[自动注册] 第 ${i + 1} 个失败: ${result.message}`);
            }
            
            // 注册间隔
            if (i < registerCount - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (error) {
            results.push({ success: false, message: error.message });
        }
    }
    
    const successCount = results.filter(r => r.success).length;
    
    res.json({
        success: successCount > 0,
        message: `注册完成: ${successCount}/${registerCount} 成功`,
        data: { results, successCount, totalCount: registerCount }
    });
});

// 单个账户注册逻辑
async function registerOneAccount() {
    const moemail = new MoeMailClient(config.moemail.baseUrl, config.moemail.apiKey);
    
    try {
        // 1. 生成临时邮箱
        console.log(`[自动注册] 正在生成临时邮箱...`);
        const emailInfo = await moemail.generateEmail();
        console.log(`[自动注册] 生成邮箱: ${emailInfo.email}, ID: ${emailInfo.id}`);
        
        // 2. 发送验证码
        console.log(`[自动注册] 正在发送验证码到 ${emailInfo.email}...`);
        const sendResult = await sendVerificationCode(emailInfo.email);
        console.log(`[自动注册] 发送验证码结果:`, sendResult);
        
        // 3. 等待邮件（增加超时时间到 60 秒，轮询间隔 3 秒）
        console.log(`[自动注册] 等待验证邮件...`);
        const message = await moemail.waitForEmail(emailInfo.id, 60000, 3000);
        if (!message) {
            return { success: false, message: '等待验证邮件超时', email: emailInfo.email };
        }
        
        // 打印完整的邮件对象用于调试
        console.log(`[自动注册] 收到邮件对象:`, JSON.stringify(message, null, 2));
        
        // 4. 提取验证码 - 尝试多个可能的字段
        const emailContent = message.text || message.html || message.body || message.content || '';
        console.log(`[自动注册] 邮件内容长度: ${emailContent.length}`);
        
        const code = extractVerificationCode(emailContent);
        if (!code) {
            console.log(`[自动注册] 无法提取验证码，邮件内容:`, emailContent.substring(0, 500));
            return { success: false, message: '无法从邮件中提取验证码', email: emailInfo.email };
        }
        console.log(`[自动注册] 验证码: ${code}`);
        
        // 5. 验证并获取 Token
        console.log(`[自动注册] 正在验证...`);
        const authResult = await verifyCode(emailInfo.email, code);
        console.log(`[自动注册] 验证结果:`, JSON.stringify(authResult).substring(0, 200));
        
        const token = authResult.accessToken || authResult.access_token || authResult.token;
        if (!token) {
            return { success: false, message: '验证失败，未获取到 Token', email: emailInfo.email };
        }
        
        // 6. 获取积分
        console.log(`[自动注册] 获取积分...`);
        let credits = await getCredits(token) || 0;
        
        // 7. 签到（Banana Lab 签到）
        console.log(`[自动注册] 执行 Banana Lab 签到...`);
        const checkinSuccess = await checkIn(token);
        if (checkinSuccess) {
            console.log(`[自动注册] 签到成功，重新获取积分...`);
            credits = await getCredits(token) || credits;
        }
        
        // 8. 保存账户
        const account = {
            id: Date.now().toString(),
            email: emailInfo.email,
            token,
            credits,
            lastCheckIn: checkinSuccess ? new Date().toISOString() : null,
            createdAt: new Date().toISOString()
        };
        
        data.accounts.push(account);
        saveData(data);
        
        console.log(`[自动注册] 成功! 邮箱: ${account.email}, 积分: ${credits}`);
        
        return {
            success: true,
            message: '注册成功',
            email: account.email,
            credits,
            id: account.id
        };
        
    } catch (error) {
        console.error('[自动注册] 错误:', error);
        return { success: false, message: error.message };
    }
}

// 删除账户
app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    data.accounts = data.accounts.filter(a => a.id !== id);
    saveData(data);
    res.json({ success: true, message: '账户已删除' });
});

// 刷新账户积分
app.post('/api/accounts/:id/refresh', async (req, res) => {
    const { id } = req.params;
    const account = data.accounts.find(a => a.id === id);
    
    if (!account) {
        return res.json({ success: false, message: '账户不存在' });
    }
    
    const credits = await getCredits(account.token);
    if (credits === null) {
        return res.json({ success: false, message: 'Token 已失效' });
    }
    
    account.credits = credits;
    saveData(data);
    
    res.json({ success: true, data: { credits } });
});

// 账户签到
app.post('/api/accounts/:id/checkin', async (req, res) => {
    const { id } = req.params;
    const account = data.accounts.find(a => a.id === id);
    
    if (!account) {
        return res.json({ success: false, message: '账户不存在' });
    }
    
    const success = await checkIn(account.token);
    if (success) {
        account.lastCheckIn = new Date().toISOString();
        // 刷新积分
        const credits = await getCredits(account.token);
        if (credits !== null) {
            account.credits = credits;
        }
        saveData(data);
    }
    
    res.json({ success, message: success ? '签到成功' : '签到失败（可能已签到）' });
});

// 全部签到
app.post('/api/accounts/checkin-all', async (req, res) => {
    let successCount = 0;
    
    for (const account of data.accounts) {
        if (account.token) {
            const success = await checkIn(account.token);
            if (success) {
                successCount++;
                account.lastCheckIn = new Date().toISOString();
                const credits = await getCredits(account.token);
                if (credits !== null) {
                    account.credits = credits;
                }
            }
        }
    }
    
    saveData(data);
    res.json({ success: true, message: `签到完成: ${successCount}/${data.accounts.length}` });
});

// 刷新所有账户积分
app.post('/api/accounts/refresh-all', async (req, res) => {
    for (const account of data.accounts) {
        if (account.token) {
            const credits = await getCredits(account.token);
            if (credits !== null) {
                account.credits = credits;
            }
        }
    }
    saveData(data);
    res.json({ success: true, message: '积分已刷新' });
});

// 生成图片
app.post('/api/generate', async (req, res) => {
    const { prompt, imageSize, aspectRatio, referenceImageUrls, accountId } = req.body;
    
    if (!prompt) {
        return res.json({ success: false, message: '提示词不能为空' });
    }
    
    // 选择账户
    let account;
    if (accountId) {
        account = data.accounts.find(a => a.id === accountId);
    } else {
        account = getAvailableAccount();
    }
    
    if (!account) {
        return res.json({ success: false, message: '没有可用的账户（积分不足）' });
    }
    
    try {
        const result = await generateImage(account.token, {
            prompt,
            imageSize: imageSize || config.generation?.defaultSize || '2K',
            aspectRatio: aspectRatio || config.generation?.defaultRatio || '1:1',
            referenceImageUrls
        });
        
        if (result.code !== 0 && result.message) {
            return res.json({ success: false, message: result.message });
        }
        
        const taskId = result.taskId || result.id || result.data?.taskId || result.data?.id;
        
        // 记录任务
        const task = {
            id: taskId,
            accountId: account.id,
            prompt,
            imageSize,
            aspectRatio,
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        data.tasks.push(task);
        saveData(data);
        
        res.json({ 
            success: true, 
            data: { 
                taskId,
                accountEmail: account.email
            }
        });
        
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 批量生成（旧版，保留兼容）
app.post('/api/generate/batch', async (req, res) => {
    const { prompt, imageSize, aspectRatio, count = 1 } = req.body;
    
    if (!prompt) {
        return res.json({ success: false, message: '提示词不能为空' });
    }
    
    const results = [];
    const interval = config.generation?.interval || 2000;
    
    for (let i = 0; i < count; i++) {
        const account = getAvailableAccount();
        if (!account) {
            results.push({ success: false, message: '没有可用账户' });
            continue;
        }
        
        try {
            const result = await generateImage(account.token, {
                prompt,
                imageSize: imageSize || '2K',
                aspectRatio: aspectRatio || '1:1'
            });
            
            const taskId = result.taskId || result.id || result.data?.taskId;
            results.push({ success: true, taskId, accountEmail: account.email });
            
            // 记录任务
            data.tasks.push({
                id: taskId,
                accountId: account.id,
                prompt,
                status: 'pending',
                createdAt: new Date().toISOString()
            });
            
        } catch (error) {
            results.push({ success: false, message: error.message });
        }
        
        // 间隔
        if (i < count - 1) {
            await new Promise(r => setTimeout(r, interval));
        }
    }
    
    saveData(data);
    res.json({ success: true, data: results });
});

// ==================== 并发任务 API ====================

// 启动并发生图任务
app.post('/api/concurrent/start', async (req, res) => {
    const { configs, selectedAccountIds, concurrency = 1, interval = 2000, maxRounds = 0 } = req.body;
    
    if (!configs || !Array.isArray(configs) || configs.length === 0) {
        return res.json({ success: false, message: '配置列表不能为空' });
    }
    
    // 检查是否已有运行中的任务
    if (currentConcurrentTask && currentConcurrentTask.status === 'running') {
        return res.json({
            success: false,
            message: '已有运行中的并发任务，请先停止',
            currentTask: currentConcurrentTask.getStatus()
        });
    }
    
    // 创建新任务
    currentConcurrentTask = new ConcurrentTask({
        configs,
        selectedAccountIds,
        concurrency: Math.max(1, Math.min(20, parseInt(concurrency) || 1)), // 1-20
        interval: Math.max(500, parseInt(interval) || 2000), // 最少0.5秒间隔
        maxRounds: parseInt(maxRounds) || 0
    });
    
    const result = await currentConcurrentTask.start();
    
    res.json({
        success: result.success,
        message: result.success ? '并发任务已启动' : result.message,
        data: result.success ? currentConcurrentTask.getStatus() : null
    });
});

// 停止并发任务
app.post('/api/concurrent/stop', (req, res) => {
    if (!currentConcurrentTask) {
        return res.json({ success: false, message: '没有运行中的任务' });
    }
    
    if (currentConcurrentTask.status !== 'running') {
        return res.json({
            success: false,
            message: '任务已停止',
            data: currentConcurrentTask.getStatus()
        });
    }
    
    currentConcurrentTask.stop('手动停止');
    
    res.json({
        success: true,
        message: '任务已停止',
        data: currentConcurrentTask.getStatus()
    });
});

// 获取并发任务状态
app.get('/api/concurrent/status', (req, res) => {
    if (!currentConcurrentTask) {
        return res.json({
            success: true,
            data: {
                hasTask: false,
                availableAccounts: data.accounts.filter(a => a.credits >= MIN_CREDITS_REQUIRED && a.token).length
            }
        });
    }
    
    res.json({
        success: true,
        data: {
            hasTask: true,
            ...currentConcurrentTask.getStatus()
        }
    });
});

// 获取并发任务的生成结果
app.get('/api/concurrent/results', (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    
    if (!currentConcurrentTask) {
        return res.json({ success: true, data: { list: [], total: 0 } });
    }
    
    const results = currentConcurrentTask.results;
    const start = (page - 1) * limit;
    const pageResults = results.slice(start, start + parseInt(limit));
    
    res.json({
        success: true,
        data: {
            list: pageResults,
            total: results.length,
            page: parseInt(page),
            limit: parseInt(limit)
        }
    });
});

// 手动刷新并发任务参与账户的积分
app.post('/api/concurrent/refresh-credits', async (req, res) => {
    if (!currentConcurrentTask) {
        return res.json({ success: false, message: '没有运行中的任务' });
    }
    
    const hasAvailable = await currentConcurrentTask.refreshCredits();
    
    res.json({
        success: true,
        data: {
            hasAvailableAccounts: hasAvailable,
            accounts: currentConcurrentTask.participatingAccounts.map(a => ({
                id: a.id,
                email: a.email,
                credits: a.credits,
                available: a.credits >= MIN_CREDITS_REQUIRED
            }))
        }
    });
});

// 获取图片列表（从所有账户）
// 真实 API 响应结构:
// {
//   code: 0,
//   data: {
//     images: [
//       {
//         id, status, prompt, imageSize, aspectRatio, isPublic,
//         imageUrl (带签名原图), thumbnailUrl (公开缩略图),
//         createdAt, updatedAt, ...
//       }
//     ],
//     pagination: { total, page, pageSize }
//   }
// }
app.get('/api/images', async (req, res) => {
    const { page = 1, pageSize = 20, accountId, keyword, aspectRatio, status } = req.query;
    let allImages = [];
    
    // 如果指定了账户，只获取该账户的图片
    const accountsToFetch = accountId
        ? data.accounts.filter(a => a.id === accountId)
        : data.accounts;
    
    // 并行获取所有账户的图片（带并发限制，防止触发防火墙）
    const results = [];
    const BATCH_SIZE = 2; // 降低并发数到2
    
    console.log(`[图库] 开始获取 ${accountsToFetch.length} 个账户的图片...`);

    for (let i = 0; i < accountsToFetch.length; i += BATCH_SIZE) {
        const batch = accountsToFetch.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (account) => {
            if (!account.token) return [];
            try {
                // 降低 pageSize 到 100，提高稳定性
                // 如果需要更多图片，应该实现分页循环获取，这里暂时先获取最新的100张
                const result = await getImageList(account.token, 1, 100);
                
                if (result.code !== 0) {
                    console.log(`[图库] 账户 ${account.email} 获取失败: ${result.message || '未知错误'}`);
                    return [];
                }
                
                const images = result.data?.images || [];
                console.log(`[图库] 账户 ${account.email} 获取成功: ${images.length} 张`);
                
                return images.map(img => ({
                    ...img,
                    accountId: account.id,
                    accountEmail: account.email
                }));
            } catch (e) {
                console.error(`[图库] 获取账户 ${account.email} 图片异常:`, e.message);
                return [];
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // 批次之间稍微停顿一下
        if (i + BATCH_SIZE < accountsToFetch.length) {
            await new Promise(r => setTimeout(r, 500)); // 增加间隔到500ms
        }
    }

    allImages = results.flat();
    
    // 1. 过滤
    if (keyword) {
        const lowerKeyword = keyword.toLowerCase();
        allImages = allImages.filter(img =>
            (img.prompt && img.prompt.toLowerCase().includes(lowerKeyword)) ||
            (img.id && img.id.includes(lowerKeyword))
        );
    }

    if (aspectRatio) {
        allImages = allImages.filter(img => img.aspectRatio === aspectRatio);
    }

    if (status) {
        allImages = allImages.filter(img => img.status === status);
    }
    
    // 2. 排序（最新的在前）
    allImages.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    // 3. 分页
    const total = allImages.length;
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const start = (p - 1) * ps;
    const pageImages = allImages.slice(start, start + ps);
    
    res.json({
        success: true,
        data: {
            images: pageImages,
            pagination: {
                total: total,
                page: p,
                pageSize: ps
            }
        }
    });
});

// 获取单个账户的图片列表
app.get('/api/accounts/:id/images', async (req, res) => {
    const { id } = req.params;
    const { page = 1, pageSize = 16 } = req.query;
    
    const account = data.accounts.find(a => a.id === id);
    if (!account) {
        return res.json({ success: false, message: '账户不存在' });
    }
    
    if (!account.token) {
        return res.json({ success: false, message: '账户 Token 无效' });
    }
    
    try {
        const result = await getImageList(account.token, parseInt(page), parseInt(pageSize));
        
        if (result.code !== 0) {
            return res.json({ success: false, message: result.message || '获取失败' });
        }
        
        // 添加账户信息到每张图片
        const images = (result.data?.images || []).map(img => ({
            ...img,
            accountId: account.id,
            accountEmail: account.email
        }));
        
        res.json({
            success: true,
            data: {
                images,
                pagination: result.data?.pagination || { total: images.length, page: parseInt(page), pageSize: parseInt(pageSize) }
            }
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 批量删除图片 (v2)
app.post('/api/images/batch-delete-v2', async (req, res) => {
    const { items } = req.body; // items: [{ id: 'xxx', accountId: 'xxx' }]
    
    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.json({ success: false, message: '请选择要删除的图片' });
    }
    
    const results = [];
    let successCount = 0;
    
    // 按账户分组，减少查找账户的次数
    const itemsByAccount = {};
    for (const item of items) {
        if (!itemsByAccount[item.accountId]) {
            itemsByAccount[item.accountId] = [];
        }
        itemsByAccount[item.accountId].push(item.id);
    }
    
    // 遍历每个账户进行删除
    for (const accountId in itemsByAccount) {
        const account = data.accounts.find(a => a.id === accountId);
        if (!account || !account.token) {
            // 账户不存在或无Token，标记该账户下的所有图片删除失败
            itemsByAccount[accountId].forEach(id => {
                results.push({ id, success: false, message: '账户无效' });
            });
            continue;
        }
        
        const imageIds = itemsByAccount[accountId];
        
        // 并行删除该账户下的图片
        const deletePromises = imageIds.map(async (id) => {
            try {
                const response = await fetch(`${API.BANANA}/images/${id}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${account.token}`,
                        'Origin': 'https://banana.listenhub.ai',
                        'Referer': 'https://banana.listenhub.ai/'
                    }
                });
                
                if (response.ok) {
                    return { id, success: true };
                } else {
                    return { id, success: false, message: `API错误: ${response.status}` };
                }
            } catch (e) {
                return { id, success: false, message: e.message };
            }
        });
        
        const accountResults = await Promise.all(deletePromises);
        results.push(...accountResults);
    }
    
    successCount = results.filter(r => r.success).length;
    
    res.json({
        success: true,
        message: `删除完成: ${successCount}/${items.length} 成功`,
        data: { results }
    });
});

// 获取图片详情（包含原图 URL）
// 注意：图片详情可以从图库列表中获取，也可以单独请求
// 原图 URL (imageUrl) 带有签名，有效期 1 小时
// 缩略图 URL (thumbnailUrl) 是公开的，无需签名
app.get('/api/images/:id', async (req, res) => {
    const { id } = req.params;
    const { accountId } = req.query;
    
    // 如果指定了账户
    if (accountId) {
        const account = data.accounts.find(a => a.id === accountId);
        if (!account) {
            return res.json({ success: false, message: '账户不存在' });
        }
        
        try {
            // 从图库列表中查找该图片 (增加深度)
            const result = await getImageList(account.token, 1, 500);
            const images = result.data?.images || [];
            const image = images.find(img => img.id === id);
            
            if (image) {
                return res.json({
                    success: true,
                    data: {
                        ...image,
                        accountId: account.id,
                        accountEmail: account.email
                    }
                });
            }
            
            return res.json({ success: false, message: '图片不存在' });
        } catch (error) {
            return res.json({ success: false, message: error.message });
        }
    }
    
    // 未指定账户，尝试所有账户
    for (const account of data.accounts) {
        if (!account.token) continue;
        
        try {
            const result = await getImageList(account.token, 1, 500);
            const images = result.data?.images || [];
            const image = images.find(img => img.id === id);
            
            if (image) {
                return res.json({
                    success: true,
                    data: {
                        ...image,
                        accountId: account.id,
                        accountEmail: account.email
                    }
                });
            }
        } catch (e) {
            // 继续尝试下一个账户
        }
    }
    
    return res.json({ success: false, message: '图片不存在' });
});

// 刷新图片的原图 URL（重新获取带签名的 URL）
app.post('/api/images/:id/refresh-url', async (req, res) => {
    const { id } = req.params;
    const { accountId } = req.body;
    
    const account = accountId
        ? data.accounts.find(a => a.id === accountId)
        : data.accounts.find(a => a.token);
    
    if (!account) {
        return res.json({ success: false, message: '没有可用账户' });
    }
    
    try {
        const result = await getImageList(account.token, 1, 500);
        const images = result.data?.images || [];
        const image = images.find(img => img.id === id);
        
        if (image && image.imageUrl) {
            return res.json({
                success: true,
                data: {
                    id: image.id,
                    imageUrl: image.imageUrl,
                    thumbnailUrl: image.thumbnailUrl,
                    expiresIn: 3600 // URL 有效期约 1 小时
                }
            });
        }
        
        return res.json({ success: false, message: '图片不存在或未生成完成' });
    } catch (error) {
        return res.json({ success: false, message: error.message });
    }
});

// 代理下载图片
app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ success: false, message: 'URL 不能为空' });
    }
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status).json({ success: false, message: '下载失败' });
        }
        
        const contentType = response.headers.get('content-type');
        res.setHeader('Content-Type', contentType || 'image/png');
        res.setHeader('Content-Disposition', 'attachment; filename="image.png"');
        
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 获取图片上传 URL
app.post('/api/upload/url', async (req, res) => {
    const { fileKey, contentType, accountId } = req.body;
    
    // 选择账户
    let account;
    if (accountId) {
        account = data.accounts.find(a => a.id === accountId);
    } else {
        account = getAvailableAccount();
    }
    
    if (!account) {
        return res.json({ success: false, message: '没有可用账户' });
    }
    
    try {
        const response = await fetch(`${API.BANANA}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.token}`,
                'Content-Type': 'application/json',
                'Origin': 'https://banana.listenhub.ai',
                'Referer': 'https://banana.listenhub.ai/'
            },
            body: JSON.stringify({ fileKey, contentType })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            return res.json({ success: false, message: result.message || '获取上传URL失败' });
        }
        
        res.json({ success: true, data: result.data || result });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 代理上传文件 (解决 CORS 问题)
app.put('/api/upload/proxy', async (req, res) => {
    const { uploadUrl, contentType } = req.query;
    
    if (!uploadUrl) {
        return res.status(400).json({ success: false, message: 'uploadUrl 不能为空' });
    }
    
    try {
        // 流式转发请求体
        const response = await fetch(decodeURIComponent(uploadUrl), {
            method: 'PUT',
            headers: {
                'Content-Type': contentType || 'application/octet-stream'
            },
            body: req, // 直接将请求流转发
            duplex: 'half' // Node.js fetch 需要此选项
        });
        
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ success: false, message: `上传失败: ${text}` });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`\n🍌 香蕉实验室独立前端服务已启动`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   账户数: ${data.accounts.length}`);
    console.log(`   可用账户: ${data.accounts.filter(a => a.credits >= 15).length}`);
    console.log(`\n`);
});

// ==================== 心跳与自动任务 ====================

let lastCreditsRefresh = 0;
let lastAutoCheckin = '';

// 心跳任务
async function heartbeat() {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    
    // 检查是否需要刷新积分（每5分钟）
    if (now - lastCreditsRefresh > CREDITS_REFRESH_INTERVAL) {
        console.log('[心跳] 刷新所有账户积分...');
        for (const account of data.accounts) {
            if (account.token) {
                try {
                    const credits = await getCredits(account.token);
                    if (credits !== null) {
                        const oldCredits = account.credits;
                        account.credits = credits;
                        if (oldCredits !== credits) {
                            console.log(`[心跳] ${account.email}: 更新账户积分，实际积分为：${credits}`);
                        }
                    }
                } catch (e) {
                    console.error(`[心跳] 刷新 ${account.email} 积分失败:`, e.message);
                }
            }
        }
        saveData(data);
        lastCreditsRefresh = now;
    }
    
    // 检查是否需要自动签到（每天一次）
    const currentHour = new Date().getHours();
    if (currentHour >= AUTO_CHECKIN_HOUR && lastAutoCheckin !== today) {
        console.log('[心跳] 执行每日自动签到...');
        let successCount = 0;
        for (const account of data.accounts) {
            if (account.token) {
                try {
                    const success = await checkIn(account.token);
                    if (success) {
                        successCount++;
                        account.lastCheckIn = new Date().toISOString();
                        console.log(`[心跳] ${account.email} 签到成功`);
                    }
                } catch (e) {
                    console.error(`[心跳] ${account.email} 签到失败:`, e.message);
                }
                // 签到间隔，避免请求过快
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        saveData(data);
        lastAutoCheckin = today;
        console.log(`[心跳] 自动签到完成: ${successCount}/${data.accounts.length}`);
    }
}

// 启动心跳
setInterval(heartbeat, HEARTBEAT_INTERVAL);

// 启动时立即执行一次
setTimeout(heartbeat, 5000);

console.log(`[心跳] 已启动，间隔 ${HEARTBEAT_INTERVAL/1000}秒，积分刷新间隔 ${CREDITS_REFRESH_INTERVAL/1000}秒`);