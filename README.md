# OpenAI KeyPool Desktop

一个单用户桌面应用，用于统一管理：

- 上游 API 地址
- 多个上游 API Key
- 一个本地统一集成 Key
- 每个 Key 的本地用量统计
- OpenAI Compatible 本地代理接口

适合把多个上游账号/Key 汇总到一个本地代理里，再提供给支持 OpenAI API 的客户端使用。

## 功能

- 本地管理后台：`/admin`
- 本地 OpenAI Compatible 代理：`/v1`
- 多个上游 Key 轮询/切换
- 失败 Key 自动跳过（401/403/429/5xx）
- 流式和非流式请求支持
- 统一本地 API Key 鉴权
- 每个上游 Key 用量统计
- Electron 桌面窗口

## 项目结构

```text
.
├── api-key-pool-proxy-enhanced.js   # 后端代理与管理 API
├── main.js                          # Electron 桌面入口
├── public/admin.html                # 管理后台页面
├── config.example.json              # 脱敏配置示例
├── api_keys.example.json            # 脱敏 Key 池示例
├── usage_stats.example.json         # 统计文件示例
├── start.sh                         # 本地启动脚本
└── package.json
```

## 安装

```bash
npm install
```

## 初始化配置

复制示例文件：

```bash
cp config.example.json config.json
cp api_keys.example.json api_keys.json
cp usage_stats.example.json usage_stats.json
```

然后编辑：

- `config.json`
- `api_keys.json`

### config.json

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "upstream_url": "https://api.freemodel.dev/v1/chat/completions",
  "proxy_api_key": "ak_replace_with_your_local_proxy_key",
  "default_model": "gpt-5.5"
}
```

### api_keys.json

```json
{
  "api_keys": [
    {
      "name": "provider-1",
      "key": "replace-with-your-upstream-key-1",
      "model": "gpt-5.5",
      "daily_quota": 1000,
      "used_today": 0,
      "last_reset": "2026-06-09",
      "enabled": true
    }
  ]
}
```

## 启动方式

### 仅启动代理服务

```bash
npm start
```

然后访问：

- 管理页：`http://127.0.0.1:8080/admin`
- 代理接口：`http://127.0.0.1:8080/v1`

### 启动桌面应用

```bash
npm run desktop
```

## 客户端接入

推荐填写：

- Base URL：`http://127.0.0.1:8080`
- API 路径由客户端自行拼接
- API Key：`config.json` 中的 `proxy_api_key`
- 模型：`gpt-5.5` 或你配置的默认模型

### 说明

有些客户端会自动拼接：

- `/v1/chat/completions`
- `/chat/completions`
- `/v1/models`
- `/models`
- `/v1/messages`

本项目已兼容这些常见路径。

## 管理后台能力

- 查看/复制统一 Base URL
- 查看/复制统一 API Key
- 修改上游接口地址
- 修改默认模型
- 添加/编辑/删除上游 Key
- 启用/停用单个 Key
- 查看总请求数与 token 统计
- 查看每个模型和每个 Key 的本地用量

## 安全说明

请不要把以下文件提交到 Git：

- `config.json`
- `api_keys.json`
- `usage_stats.json`
- `*.log`

这些文件已加入 `.gitignore`。

## 已知限制

- 用量统计是本地统计，不一定等于上游官方账单
- 某些上游服务会有 IP / 账号策略限制
- 流式统计依赖上游是否在最终 chunk 返回 usage

## 开发

语法检查：

```bash
node --check api-key-pool-proxy-enhanced.js
node --check main.js
```

## License

MIT
