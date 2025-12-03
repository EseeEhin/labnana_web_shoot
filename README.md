# 🍌 香蕉实验室独立前端 (Banana Lab Web)

一个功能完整的 Banana Lab (ListenHub) AI 图片生成平台独立前端工具，支持多账户管理、批量生成、图库管理等功能。

## ✨ 功能特性

### 🔐 账户管理
- **自动注册** - 集成 MoEmail 临时邮箱，一键自动注册新账户
- **并发注册** - 支持批量注册，可配置并发数（1-5），大幅提升注册效率
- **手动注册** - 启动浏览器无痕窗口，手动完成注册
- **Token 导入** - 支持手动添加已有账户的 Token
- **积分监控** - 实时显示各账户积分余额
- **自动签到** - 每日自动签到获取积分
- **心跳系统** - 定时刷新积分、自动签到
- **批量管理** - 按积分分类折叠显示（可用/不可用），支持多选批量删除
- **注册后跳转** - 注册成功后自动访问指定链接（使用 Puppeteer 模拟浏览器）

### 🎨 图片生成
- **单张生成** - 快速生成单张图片
- **批量生成** - 支持批量提交生成任务
- **并发生成** - 多账户并发生成，自动轮询
- **智能选择** - 自动选择积分充足的账户
- **参数配置** - 支持画质(1K/2K/4K)、比例(1:1/3:4/4:3/16:9/9:16)
- **图生图** - 支持上传参考图进行生成

### 🖼️ 图库管理
- **图片列表** - 查看所有账户的生成图片
- **状态显示** - 实时显示生成状态（排队中/生成中/已完成/失败）
- **筛选功能** - 按账户、状态筛选图片
- **图片详情** - 查看提示词、尺寸、比例、可见性等信息
- **原图下载** - 下载高清原图 (PNG)
- **缩略图下载** - 下载压缩缩略图 (WebP)
- **极简模式** - 提供无干扰的纯图片浏览模式，适合快速查看和调试

### 💅 界面体验
- **主题切换** - 支持深色/浅色模式一键切换 🌙/☀️
- **响应式设计** - 完美适配手机、平板和桌面端
- **视觉优化** - 更大的字体、更清晰的布局、流畅的加载动画
- **状态反馈** - 优化的图片生成状态展示（排队/生成中动画）
- **账户分类** - 按积分自动分类（可用 ≥15 / 不可用 <15），可折叠展示

### 🔧 其他功能
- **油猴脚本** - Token 自动抓取同步脚本
- **代理下载** - 解决跨域下载问题
- **配置持久化** - 配置自动保存

## 🚀 快速启动

### Windows 用户
双击运行 `start.bat` 即可。

### macOS / Linux 用户
在终端运行：
```bash
chmod +x start.sh
./start.sh
```

服务启动后访问: http://localhost:3000

## 📦 手动安装

### 环境要求
- Node.js 18+
- npm 或 yarn

### 安装步骤

```bash
# 进入项目目录
cd banana-web

# 安装依赖
npm install

# 启动服务
npm start
```

## ⚙️ 配置

### MoEmail 配置（自动注册必需）

在设置页面配置 MoEmail 服务：

| 配置项 | 说明 |
|--------|------|
| API 地址 | MoEmail 服务地址，如 `https://mail.example.com` |
| API Key | MoEmail API 密钥 |

### 配置文件

项目包含一个 `config.json.example` 示例文件。请将其复制为 `config.json` 并填入你的配置：

```json
{
  "moemail": {
    "baseUrl": "https://mail.example.com",
    "apiKey": "your-api-key"
  },
  "fingerprint": {
    "browserPath": ""
  },
  "generation": {
    "defaultPrompt": "",
    "defaultSize": "2K",
    "defaultRatio": "1:1",
    "interval": 2000
  }
}
```

## 🔑 添加账户

### 方式一：自动注册（推荐）

1. 配置 MoEmail 服务
2. 设置注册数量（1-20）和并发数（1-5）
3. 点击「🤖 自动注册」按钮
4. 等待自动完成注册、验证、签到

### 方式二：油猴脚本同步（推荐手动登录用户）

1. 安装 Tampermonkey 浏览器扩展
2. 打开 `token-grabber.user.js` 文件，点击安装
3. 登录 https://listenhub.ai 或 https://banana.listenhub.ai
4. 页面右下角会出现 🍌 按钮
5. 点击按钮，脚本会自动：
   - 读取登录 Cookie 中的 Token
   - 获取用户信息和积分
   - 检查签到状态
   - 发送到本地服务器同步

**脚本功能：**
- ✅ 自动检测登录状态
- ✅ 自动解码 URL 编码的 Token
- ✅ 获取真实积分（使用 `/users/subscription` API）
- ✅ 显示签到状态
- ✅ 一键同步到本地服务

### 方式三：手动添加 Token

1. 登录 https://banana.listenhub.ai
2. 按 F12 打开开发者工具
3. Application → Cookies → `app_access_token`
4. 复制 Token 值（去掉 `Bearer%20` 前缀）
5. 在本工具点击「🔑 添加 Token」

## 📡 API 接口

### 系统状态
```
GET /api/status
```

### 账户管理
```
GET    /api/accounts              # 获取账户列表
POST   /api/accounts/add          # 添加账户
POST   /api/accounts/auto-register # 自动注册（支持 count 和 concurrency 参数）
DELETE /api/accounts/:id          # 删除账户
POST   /api/accounts/batch-delete # 批量删除账户
POST   /api/accounts/:id/refresh  # 刷新积分
POST   /api/accounts/:id/checkin  # 签到
POST   /api/accounts/checkin-all  # 全部签到
POST   /api/accounts/refresh-all  # 刷新所有积分
```

### 图片生成
```
POST /api/generate       # 单张生成
POST /api/generate/batch # 批量生成
```

### 并发任务
```
POST /api/concurrent/start   # 启动并发任务
POST /api/concurrent/stop    # 停止并发任务
GET  /api/concurrent/status  # 获取任务状态
```

### 图库管理
```
GET  /api/images                    # 获取图片列表
GET  /api/images/:id                # 获取图片详情
GET  /api/accounts/:id/images       # 获取账户图片
POST /api/images/:id/refresh-url    # 刷新图片URL
GET  /api/download?url=xxx          # 代理下载
```

### 调试工具
- **极简图库**: 访问 `/simple-gallery.html` 可进入极简模式，直接查看所有获取到的图片，用于排查显示问题。

## 🔌 Banana Lab API 参考

### 基础端点
- ListenHub Auth: `https://listenhub.ai/api/listenhub/v1/`
- Banana API: `https://api.listenhub.ai/api/v1/banana/`
- Users API: `https://api.listenhub.ai/api/v1/users/`

### 主要接口

| 接口 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 发送验证码 | POST | `/listenhub/v1/email` | 发送登录验证码 |
| 验证登录 | POST | `/listenhub/v1/auth/signin/email-code` | 验证码登录 |
| 获取积分 | GET | `/users/subscription` | 返回 `totalAvailableCredits` |
| 签到状态 | GET | `/banana/checkin/status` | 检查今日签到状态 |
| 执行签到 | POST | `/banana/checkin` | 签到获取积分 |
| 生成图片 | POST | `/banana/images` | 提交生成任务 |
| 图库列表 | GET | `/banana/images?page=1&pageSize=16` | 获取图片列表 |

### 图片数据结构

```json
{
  "id": "692e86767cbb9b7d66eb887d",
  "status": "success",
  "prompt": "a cute cat sitting on a table",
  "imageSize": "2K",
  "aspectRatio": "1:1",
  "isPublic": false,
  "imageUrl": "https://storage.googleapis.com/...?X-Goog-Signature=...",
  "thumbnailUrl": "https://storage.googleapis.com/listenhub-labs-public/...",
  "createdAt": 1764656758137,
  "updatedAt": 1764657050725
}
```

**注意：**
- `imageUrl` 是带签名的原图 URL，有效期约 1 小时
- `thumbnailUrl` 是公开的缩略图 URL，无需签名

## 🔧 油猴脚本详解

### 文件位置
`banana-web/token-grabber.user.js`

### 安装方法
1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `token-grabber.user.js` 文件
3. Tampermonkey 会自动识别并提示安装
4. 点击「安装」按钮

### 使用方法
1. 访问 https://listenhub.ai 或 https://banana.listenhub.ai
2. 完成登录
3. 页面右下角会出现 🍌 悬浮按钮
4. 点击按钮，等待同步完成
5. 打开 http://localhost:3000 查看已同步的账户

### 脚本功能
| 功能 | 说明 |
|------|------|
| Token 抓取 | 从 Cookie 中读取 `app_access_token` |
| URL 解码 | 自动解码 `Bearer%20...` 格式的 Token |
| 用户信息 | 调用 `/users/me` 获取邮箱、昵称 |
| 积分查询 | 调用 `/users/subscription` 获取真实积分 |
| 签到状态 | 调用 `/banana/checkin/status` 检查签到 |
| 自动检测 | 每 3 秒检测登录状态变化 |
| 新登录提示 | 检测到新 Token 时按钮会闪烁提示 |

### 抓取的数据
```javascript
{
  email: "user@example.com",     // 用户邮箱
  token: "eyJhbGciOiJIUzI1...",  // JWT Token（纯 Token，不含 Bearer 前缀）
  cookies: {                     // 所有相关 Cookie
    "app_access_token": "...",
    "app_refresh_token": "...",
    "NEXT_LOCALE": "zh",
    // ...
  },
  credits: 60,                   // 当前积分
  userInfo: {                    // 用户详细信息
    email: "...",
    nickname: "...",
    avatar: "...",
    // ...
  }
}
```

### 注意事项
- 确保本地服务 (http://localhost:3000) 已启动
- 脚本会自动记录已同步的 Token，避免重复同步
- 如果 Token 失效，需要重新登录后再同步

## 📁 项目结构

```
banana-web/
├── README.md              # 完整的项目文档
├── server.js              # 后端服务
├── config.json            # 配置文件
├── data.json              # 数据存储
├── package.json           # 依赖配置
├── token-grabber.user.js  # 🔑 油猴脚本（Token 抓取器）
└── public/
    ├── index.html         # 前端页面
    ├── app.js             # 前端逻辑
    └── style.css          # 样式文件
```

## ⚠️ 免责声明

本工具仅供学习和研究使用。使用本工具时请遵守 Banana Lab / ListenHub 的服务条款。作者不对任何滥用行为负责。

## 📄 许可证

MIT License


## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

Made with ❤️ by 苏糖 🐱