const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = __dirname;

const PATHS = {
    config: path.join(BASE_DIR, 'config.json'),
    keys: path.join(BASE_DIR, 'api_keys.json'),
    stats: path.join(BASE_DIR, 'usage_stats.json'),
    admin: path.join(BASE_DIR, 'public', 'admin.html')
};

const DEFAULT_CONFIG = {
    host: '127.0.0.1',
    port: 8080,
    upstream_url: 'https://api.freemodel.dev/v1/chat/completions',
    proxy_api_key: `ak_${crypto.randomBytes(24).toString('hex')}`,
    default_model: 'gpt-5.5'
};

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function maskSecret(value) {
    if (!value) return '';
    if (value.length <= 12) return `${value.slice(0, 3)}***`;
    return `${value.slice(0, 6)}***${value.slice(-4)}`;
}

function normalizeUpstreamUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return DEFAULT_CONFIG.upstream_url;
    if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
    if (trimmed.endsWith('/v1/')) return `${trimmed}chat/completions`;
    if (!trimmed.includes('/chat/completions')) return `${trimmed.replace(/\/$/, '')}/v1/chat/completions`;
    return trimmed;
}

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 20 * 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

class AppConfig {
    constructor(filePath) {
        this.filePath = filePath;
        this.config = this.load();
    }

    load() {
        const existing = readJson(this.filePath, null);
        const merged = { ...DEFAULT_CONFIG, ...(existing || {}) };
        merged.upstream_url = normalizeUpstreamUrl(merged.upstream_url);
        if (!existing) writeJson(this.filePath, merged);
        return merged;
    }

    update(patch) {
        const next = { ...this.config };
        if (patch.host) next.host = String(patch.host).trim();
        if (patch.port) next.port = Number(patch.port) || next.port;
        if (patch.upstream_url !== undefined) next.upstream_url = normalizeUpstreamUrl(patch.upstream_url);
        if (patch.proxy_api_key !== undefined) next.proxy_api_key = String(patch.proxy_api_key).trim() || next.proxy_api_key;
        if (patch.default_model !== undefined) next.default_model = String(patch.default_model).trim() || next.default_model;
        this.config = next;
        writeJson(this.filePath, this.config);
        return this.config;
    }

    regenerateProxyKey() {
        return this.update({ proxy_api_key: `ak_${crypto.randomBytes(24).toString('hex')}` });
    }

    publicConfig() {
        return {
            ...this.config,
            base_url: `http://${this.config.host}:${this.config.port}/v1`,
            api_format: 'OpenAI Compatible'
        };
    }
}

class UsageStats {
    constructor(statsPath) {
        this.statsPath = statsPath;
        this.stats = readJson(statsPath, {
            daily: {},
            hourly: {},
            models: {},
            total: { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 } }
        });
    }

    saveStats() {
        writeJson(this.statsPath, this.stats);
    }

    recordRequest(keyName, model, tokens = {}) {
        const normalizedTokens = {
            prompt: Number(tokens.prompt || 0),
            completion: Number(tokens.completion || 0),
            total: Number(tokens.total || 0)
        };
        const today = new Date().toISOString().split('T')[0];
        const hour = new Date().getHours();
        const hourKey = `${today}-${hour}`;

        this.addBucket(this.stats.daily, today, keyName, normalizedTokens);
        this.addBucket(this.stats.hourly, hourKey, keyName, normalizedTokens);

        if (!this.stats.models[model]) this.stats.models[model] = this.emptyCounter();
        this.addCounter(this.stats.models[model], normalizedTokens);
        this.addCounter(this.stats.total, normalizedTokens);
        this.saveStats();
    }

    emptyCounter() {
        return { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
    }

    addBucket(root, bucket, keyName, tokens) {
        if (!root[bucket]) root[bucket] = {};
        if (!root[bucket][keyName]) root[bucket][keyName] = this.emptyCounter();
        this.addCounter(root[bucket][keyName], tokens);
    }

    addCounter(counter, tokens) {
        counter.requests++;
        counter.tokens.prompt += tokens.prompt;
        counter.tokens.completion += tokens.completion;
        counter.tokens.total += tokens.total;
    }

    reset() {
        this.stats = { daily: {}, hourly: {}, models: {}, total: this.emptyCounter() };
        this.saveStats();
    }

    getStats() {
        return this.stats;
    }

    getDailyStats(days = 7) {
        const today = new Date();
        const result = {};
        for (let i = 0; i < days; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const key = date.toISOString().split('T')[0];
            if (this.stats.daily[key]) result[key] = this.stats.daily[key];
        }
        return result;
    }

    getHourlyStats(hours = 24) {
        const now = new Date();
        const result = {};
        for (let i = 0; i < hours; i++) {
            const date = new Date(now);
            date.setHours(date.getHours() - i);
            const key = `${date.toISOString().split('T')[0]}-${date.getHours()}`;
            if (this.stats.hourly[key]) result[key] = this.stats.hourly[key];
        }
        return result;
    }
}

class APIKeyPool {
    constructor(configPath) {
        this.configPath = configPath;
        this.keys = [];
        this.currentIndex = 0;
        this.loadConfig();
    }

    loadConfig() {
        const config = readJson(this.configPath, null);
        if (config && Array.isArray(config.api_keys)) {
            this.keys = config.api_keys.map(key => ({ model: '', ...key }));
        } else {
            this.keys = [];
            this.saveConfig();
        }
        console.log(`[INFO] 加载了 ${this.keys.length} 个API密钥`);
    }

    saveConfig() {
        writeJson(this.configPath, { api_keys: this.keys });
    }

    checkResetDailyQuota() {
        const today = new Date().toISOString().split('T')[0];
        let changed = false;
        this.keys.forEach(keyInfo => {
            if (keyInfo.last_reset !== today) {
                keyInfo.used_today = 0;
                keyInfo.last_reset = today;
                changed = true;
            }
        });
        if (changed) this.saveConfig();
    }

    listPublic() {
        this.checkResetDailyQuota();
        return this.keys.map((keyInfo, index) => ({
            id: index,
            name: keyInfo.name || `Key ${index + 1}`,
            key_masked: maskSecret(keyInfo.key),
            model: keyInfo.model || '',
            daily_quota: keyInfo.daily_quota || 0,
            used_today: keyInfo.used_today || 0,
            last_reset: keyInfo.last_reset || null,
            enabled: keyInfo.enabled !== false
        }));
    }

    getStatus() {
        const keys = this.listPublic();
        return {
            total_keys: keys.length,
            enabled_keys: keys.filter(k => k.enabled).length,
            keys
        };
    }

    getNextKey(excluded = new Set()) {
        this.checkResetDailyQuota();
        if (!this.keys.length) return null;

        for (let i = 0; i < this.keys.length; i++) {
            const index = this.currentIndex;
            const keyInfo = this.keys[index];
            this.currentIndex = (this.currentIndex + 1) % this.keys.length;
            if (excluded.has(index)) continue;
            if (keyInfo.enabled === false) continue;
            if (!keyInfo.key) continue;
            if ((keyInfo.used_today || 0) >= (keyInfo.daily_quota || Infinity)) continue;
            return { index, keyInfo };
        }
        return null;
    }

    incrementUsage(index, amount = 1) {
        if (!this.keys[index]) return;
        this.keys[index].used_today = (this.keys[index].used_today || 0) + amount;
        this.saveConfig();
    }

    upsertKey(input) {
        const record = {
            name: String(input.name || '').trim() || '未命名 Key',
            key: String(input.key || '').trim(),
            model: String(input.model || '').trim(),
            daily_quota: Number(input.daily_quota || 1000),
            used_today: Number(input.used_today || 0),
            last_reset: input.last_reset || new Date().toISOString().split('T')[0],
            enabled: input.enabled !== false
        };

        if (!record.key && input.id === undefined) throw new Error('API Key 不能为空');

        if (input.id !== undefined && this.keys[Number(input.id)]) {
            const existing = this.keys[Number(input.id)];
            this.keys[Number(input.id)] = { ...existing, ...record, key: record.key || existing.key };
        } else {
            this.keys.push(record);
        }
        this.saveConfig();
        return this.listPublic();
    }

    deleteKey(id) {
        const index = Number(id);
        if (!this.keys[index]) throw new Error('Key 不存在');
        this.keys.splice(index, 1);
        this.saveConfig();
        return this.listPublic();
    }

    resetUsage() {
        const today = new Date().toISOString().split('T')[0];
        this.keys.forEach(key => {
            key.used_today = 0;
            key.last_reset = today;
        });
        this.saveConfig();
    }
}

class APIProxy {
    constructor(appConfig, keyPool, usageStats) {
        this.appConfig = appConfig;
        this.keyPool = keyPool;
        this.usageStats = usageStats;
        this.server = null;
    }

    async handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') return res.end();

        try {
            console.log(`[REQ] ${req.method} ${url.pathname}`);
            if (url.pathname === '/' || url.pathname === '/admin') return this.handleAdmin(res);
            if ((url.pathname === '/v1' || url.pathname === '/v1/') && req.method === 'GET') return sendJson(res, 200, { ok: true, api_format: 'OpenAI Compatible' });
            if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { status: 'healthy' });
            if (url.pathname === '/status' && req.method === 'GET') return sendJson(res, 200, this.keyPool.getStatus());
            if (url.pathname === '/stats' && req.method === 'GET') return sendJson(res, 200, this.usageStats.getStats());
            if (url.pathname === '/stats/daily' && req.method === 'GET') return sendJson(res, 200, this.usageStats.getDailyStats(Number(url.searchParams.get('days') || 7)));
            if (url.pathname === '/stats/hourly' && req.method === 'GET') return sendJson(res, 200, this.usageStats.getHourlyStats(Number(url.searchParams.get('hours') || 24)));
            if (url.pathname === '/stats/models' && req.method === 'GET') return sendJson(res, 200, this.usageStats.getStats().models);
            if (url.pathname.startsWith('/api/')) return this.handleAdminApi(req, res, url);
            if ((url.pathname === '/models' || url.pathname === '/v1/models') && req.method === 'GET') return this.handleModels(res);
            if (url.pathname.startsWith('/v1/models/') && req.method === 'GET') return this.handleModel(res, decodeURIComponent(url.pathname.slice('/v1/models/'.length)));
            if ((url.pathname === '/messages' || url.pathname === '/v1/messages') && req.method === 'POST') return this.handleAnthropicMessages(req, res);
            if ((url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions') && req.method === 'POST') return this.handleChatCompletions(req, res);
            return sendJson(res, 404, { error: 'Not Found', path: url.pathname });
        } catch (error) {
            console.error('[ERROR]', error);
            return sendJson(res, 500, { error: error.message });
        }
    }

    handleAdmin(res) {
        if (!fs.existsSync(PATHS.admin)) return sendJson(res, 404, { error: 'admin.html not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(PATHS.admin));
    }

    async handleAdminApi(req, res, url) {
        if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, this.appConfig.publicConfig());
        if (url.pathname === '/api/config' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            if (body.regenerate_proxy_key) this.appConfig.regenerateProxyKey();
            const config = this.appConfig.update(body);
            return sendJson(res, 200, { ...config, base_url: `http://${config.host}:${config.port}/v1`, api_format: 'OpenAI Compatible' });
        }
        if (url.pathname === '/api/keys' && req.method === 'GET') return sendJson(res, 200, this.keyPool.listPublic());
        if (url.pathname === '/api/keys' && req.method === 'POST') return sendJson(res, 200, this.keyPool.upsertKey(await parseRequestBody(req)));
        if (url.pathname === '/api/keys/delete' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            return sendJson(res, 200, this.keyPool.deleteKey(body.id));
        }
        if (url.pathname === '/api/stats' && req.method === 'GET') return sendJson(res, 200, this.usageStats.getStats());
        if (url.pathname === '/api/reset-usage' && req.method === 'POST') {
            this.keyPool.resetUsage();
            this.usageStats.reset();
            return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: 'Not Found' });
    }

    verifyProxyKey(req) {
        const expected = this.appConfig.config.proxy_api_key;
        const auth = req.headers.authorization || '';
        return auth === `Bearer ${expected}`;
    }

    handleModels(res) {
        const models = [...new Set(this.keyPool.keys.map(k => k.model).filter(Boolean).concat(this.appConfig.config.default_model))];
        return sendJson(res, 200, {
            object: 'list',
            data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'api-key-pool-proxy' }))
        });
    }

    handleModel(res, id) {
        return sendJson(res, 200, { id, object: 'model', created: 0, owned_by: 'api-key-pool-proxy' });
    }

    async handleAnthropicMessages(req, res) {
        const body = await parseRequestBody(req);
        const messages = [];
        if (body.system) messages.push({ role: 'system', content: Array.isArray(body.system) ? body.system.map(part => part.text || '').join('\n') : String(body.system) });
        for (const message of body.messages || []) {
            const content = Array.isArray(message.content)
                ? message.content.map(part => part.text || '').join('\n')
                : String(message.content || '');
            messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
        }
        req.__parsedBody = {
            model: body.model || this.appConfig.config.default_model,
            messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            stream: Boolean(body.stream)
        };
        return this.handleChatCompletions(req, res);
    }

    async handleChatCompletions(req, res) {
        if (!this.verifyProxyKey(req)) return sendJson(res, 401, { error: 'Invalid proxy API key' });
        const data = req.__parsedBody || await parseRequestBody(req);
        if (!data.model) data.model = this.appConfig.config.default_model;

        const excluded = new Set();
        let lastResponse = null;
        while (excluded.size < this.keyPool.keys.length) {
            const selected = this.keyPool.getNextKey(excluded);
            if (!selected) break;
            const { index, keyInfo } = selected;
            excluded.add(index);
            const requestData = { ...data, model: keyInfo.model || data.model || this.appConfig.config.default_model };
            const response = await this.forwardRequest(requestData, keyInfo, res);
            lastResponse = response;

            if (data.stream && response.streamed) {
                this.keyPool.incrementUsage(index);
                if (response.usage) this.usageStats.recordRequest(keyInfo.name, requestData.model, response.usage);
                else this.usageStats.recordRequest(keyInfo.name, requestData.model, {});
                return;
            }

            if (![401, 403, 429, 500, 502, 503, 504].includes(response.status)) {
                const usage = response.data.usage || {};
                this.usageStats.recordRequest(keyInfo.name, requestData.model, {
                    prompt: usage.prompt_tokens || 0,
                    completion: usage.completion_tokens || 0,
                    total: usage.total_tokens || 0
                });
                this.keyPool.incrementUsage(index);
                return sendJson(res, response.status, response.data);
            }
        }

        return sendJson(res, lastResponse?.status || 429, lastResponse?.data || { error: '所有API密钥不可用或额度已用完' });
    }

    forwardRequest(data, keyInfo, clientRes) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(data);
            const target = new URL(this.appConfig.config.upstream_url);
            const options = {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${keyInfo.key}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'api-key': keyInfo.key
                }
            };

            const transport = target.protocol === 'http:' ? http : https;
            const upstreamReq = transport.request(target, options, upstreamRes => {
                if (data.stream && ![401, 403, 429, 500, 502, 503, 504].includes(upstreamRes.statusCode || 0)) {
                    let usage = null;
                    clientRes.writeHead(upstreamRes.statusCode || 200, {
                        'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    upstreamRes.on('data', chunk => {
                        const text = chunk.toString('utf8');
                        for (const line of text.split('\n')) {
                            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                            try {
                                const payload = JSON.parse(line.slice(6));
                                if (payload.usage) usage = {
                                    prompt: payload.usage.prompt_tokens || 0,
                                    completion: payload.usage.completion_tokens || 0,
                                    total: payload.usage.total_tokens || 0
                                };
                            } catch {}
                        }
                        clientRes.write(chunk);
                    });
                    upstreamRes.on('end', () => {
                        clientRes.end();
                        resolve({ status: upstreamRes.statusCode || 200, data: {}, usage, streamed: true });
                    });
                    return;
                }

                let responseData = '';
                upstreamRes.on('data', chunk => { responseData += chunk; });
                upstreamRes.on('end', () => {
                    let data;
                    try {
                        data = responseData ? JSON.parse(responseData) : {};
                    } catch {
                        data = { error: responseData || 'Invalid JSON response' };
                    }
                    resolve({ status: upstreamRes.statusCode || 500, data });
                });
            });

            upstreamReq.on('error', reject);
            upstreamReq.write(postData);
            upstreamReq.end();
        });
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.server) return resolve(this.server);
            const { host, port } = this.appConfig.config;
            this.server = http.createServer(this.handleRequest.bind(this));
            this.server.on('error', reject);
            this.server.listen(port, host, () => {
                console.log(`[INFO] 管理界面: http://${host}:${port}/admin`);
                console.log(`[INFO] 集成地址: http://${host}:${port}/v1`);
                resolve(this.server);
            });
        });
    }

    stop() {
        return new Promise(resolve => {
            if (!this.server) return resolve();
            this.server.close(() => {
                this.server = null;
                resolve();
            });
        });
    }
}

function createProxy() {
    const appConfig = new AppConfig(PATHS.config);
    const keyPool = new APIKeyPool(PATHS.keys);
    const usageStats = new UsageStats(PATHS.stats);
    return new APIProxy(appConfig, keyPool, usageStats);
}

if (require.main === module) {
    createProxy().start().catch(error => {
        console.error('[FATAL]', error);
        process.exit(1);
    });
}

module.exports = { createProxy, AppConfig, APIKeyPool, UsageStats };
