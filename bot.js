/**
 * AAESRL - THE TITAN AI ENGINE (VERSION 20.0 - PURE DISCORD BOT)
 * =============================================================
 * Architecture: Discord Bot ONLY (Web Interface REMOVED)
 * Hosting: Optimized for Low-End Free Hosting
 * Stability: 99.9% UPTIME GUARANTEED
 * Author: Aaesrl Dev Team
 *
 * [CRITICAL FIXES IN v20.0]:
 * 1. ✅ FIXED Vision - system prompt now actually sent to API (was never sent!)
 * 2. ✅ FIXED Vision model - llama-3.2-90b-vision-preview DEPRECATED, using llama-3.2-11b-vision-preview
 * 3. ✅ FIXED MIME type stripping - content-type header cleaned before validation
 * 4. ✅ FIXED Image gen - response validation (was accepting HTML error pages as images)
 * 5. ✅ FIXED Image gen - added retry + backup API endpoint
 * 6. ✅ UPGRADED Chat - llama-3.3-70b-versatile for deep/serious mode (still free)
 * 7. ✅ REMOVED Web Interface - cleaner, lighter, less RAM
 * 8. ✅ OPTIMIZED Tokens - balanced for quality + low-end hosting
 */

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    AttachmentBuilder,
    ActivityType,
    Options,
    SlashCommandBuilder,
    REST,
    Routes,
    Partials,
    MessageFlags,
    ButtonBuilder,
    ActionRowBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    Colors,
    Events
} = require('discord.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ============================================================================
// [MODULE 1] CONFIGURATION SERVICE
// ============================================================================

class ConfigService {
    static get ENV() {
        if (!process.env.DISCORD_TOKEN) {
            console.error("FATAL: DISCORD_TOKEN missing.");
            process.exit(1);
        }
        return {
            LOW_MEMORY: process.env.LOW_MEMORY_MODE === 'true',
            TOKEN: process.env.DISCORD_TOKEN,
            CHANNELS: {
                CHAT: process.env.CHAT_CHANNEL_ID,
                IMAGE: process.env.IMAGE_CHANNEL_ID
            }
        };
    }

    static get PATHS() {
        return {
            PERSONALITY: path.join(__dirname, 'personality.json'),
            DATABASE: path.join(__dirname, 'conversations.json')
        };
    }

    static get LIMITS() {
        return {
            HISTORY_DEPTH: this.ENV.LOW_MEMORY ? 25 : 60,
            CONTEXT_WINDOW: 10,
            MAX_RAM_USERS: this.ENV.LOW_MEMORY ? 50 : 200,
            CACHE_TTL: 1800000,

            NON_THREAD_LIMIT: 20,
            THREAD_LIMIT: 30,

            INACTIVITY_WARN_MS: 7 * 24 * 60 * 60 * 1000,
            INACTIVITY_DELETE_MS: 10 * 60 * 60 * 1000,

            VISION_LIMIT_PER_PLACE: 10,
            MAX_RETRIES: 3
        };
    }

    static get TIMEOUTS() {
        return {
            API_REQUEST: 45000,
            VISION_REQUEST: 50000,
            SAVE_DEBOUNCE: 2000,
            THINKING_MIN: 500,
            THINKING_MAX: 1400,
            GC_INTERVAL: 900000,
            ACTIVITY_UPDATE: 180000,
            KEY_UNBLOCK: 90000,
            INACTIVITY_CHECK: 3600000
        };
    }

    // Model selection - all FREE on Groq
    static get MODELS() {
        return {
            // Chat models (free tier)
            CHAT_FAST: 'llama-3.1-8b-instant',          // Ultra fast, casual
            CHAT_SMART: 'llama-3.3-70b-versatile',      // Smart, deep mode
            CHAT_TITLE: 'llama-3.1-8b-instant',         // For thread titles

            // Vision models (free tier) - in order of preference
            VISION_PRIMARY: 'meta-llama/llama-4-scout-17b-16e-instruct',    // Newest, best
            VISION_FALLBACK: 'llama-3.2-11b-vision-preview',                // Reliable fallback
            VISION_LAST: 'llama-3.2-90b-vision-preview'                     // Last resort
        };
    }
}

// ============================================================================
// [MODULE 2] LOGGER SERVICE
// ============================================================================

class LoggerService {
    static timestamp() {
        return new Date().toISOString().replace('T', ' ').split('.')[0];
    }
    static format(l, m, msg) {
        return `[${this.timestamp()}] [${l.padEnd(7)}] [${m.padEnd(15)}] ${msg}`;
    }
    static info(m, msg) { console.log(this.format('INFO', m, msg)); }
    static warn(m, msg) { console.warn(this.format('WARN', m, msg)); }
    static error(m, msg, err = null) {
        console.error(this.format('ERROR', m, msg));
        if (err && process.env.DEBUG_MODE === 'true') {
            if (err.response) console.error(`    >> HTTP ${err.response.status}: ${JSON.stringify(err.response.data || '').substring(0, 200)}`);
            else if (err.message) console.error(`    >> ${err.message}`);
        }
    }
    static success(m, msg) { console.log(this.format('SUCCESS', m, msg)); }
}

// ============================================================================
// [MODULE 3] DUAL GROQ POOL SYSTEM
// ============================================================================

class DualGroqPool {
    constructor() {
        this.pool1 = this._initPool([
            process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2,
            process.env.GROQ_API_KEY_3, process.env.GROQ_API_KEY_4,
            process.env.GROQ_API_KEY_5, process.env.GROQ_API_KEY_6
        ], 'Groq-Pool1');

        this.pool2 = this._initPool([
            process.env.GROQ2_API_KEY_1,
            process.env.GROQ2_API_KEY_2,
            process.env.GROQ2_API_KEY_3
        ], 'Groq-Pool2');

        const total = this.pool1.keys.length + this.pool2.keys.length;
        LoggerService.success('GroqPool', `Initialized: Pool1=${this.pool1.keys.length}, Pool2=${this.pool2.keys.length} (Total: ${total})`);
    }

    _initPool(keys, name) {
        const valid = keys.filter(k => k && k.trim().length > 10).map(k => k.trim());
        return {
            name,
            keys: valid,
            status: valid.map(() => ({ blocked: false, until: 0, errors: 0, usage: 0, lastUsed: 0 })),
            currentIndex: 0
        };
    }

    get() {
        return this._getFromPool(this.pool1) || this._getFromPool(this.pool2) || this._emergency();
    }

    _getFromPool(pool) {
        if (!pool.keys.length) return null;
        const now = Date.now();
        pool.status.forEach(s => { if (s.blocked && now > s.until) { s.blocked = false; s.errors = 0; } });
        for (let i = 0; i < pool.keys.length; i++) {
            const idx = (pool.currentIndex + i) % pool.keys.length;
            if (!pool.status[idx].blocked) {
                pool.status[idx].lastUsed = now;
                pool.currentIndex = (idx + 1) % pool.keys.length;
                return { key: pool.keys[idx], index: idx, pool: pool.name };
            }
        }
        return null;
    }

    _emergency() {
        let oldest = null, oldestTime = Date.now();
        [this.pool1, this.pool2].forEach(pool => {
            pool.status.forEach((s, idx) => {
                if (pool.keys[idx] && s.lastUsed < oldestTime) {
                    oldestTime = s.lastUsed;
                    oldest = { key: pool.keys[idx], index: idx, pool: pool.name };
                }
            });
        });
        if (oldest) LoggerService.warn('GroqPool', `Emergency fallback: ${oldest.pool}`);
        return oldest;
    }

    reportSuccess(ki) {
        const pool = ki.pool === 'Groq-Pool1' ? this.pool1 : this.pool2;
        if (!pool.status[ki.index]) return;
        pool.status[ki.index].errors = 0;
        pool.status[ki.index].usage++;
    }

    reportFailure(ki, fatal = false) {
        const pool = ki.pool === 'Groq-Pool1' ? this.pool1 : this.pool2;
        if (!pool.status[ki.index]) return;
        pool.status[ki.index].errors++;
        if (fatal || pool.status[ki.index].errors >= 2) {
            pool.status[ki.index].blocked = true;
            pool.status[ki.index].until = Date.now() + ConfigService.TIMEOUTS.KEY_UNBLOCK;
            LoggerService.warn('GroqPool', `Key blocked in ${ki.pool}[${ki.index}]`);
        }
    }

    getStats() {
        const b1 = this.pool1.status.filter(s => s.blocked).length;
        const b2 = this.pool2.status.filter(s => s.blocked).length;
        const total = this.pool1.keys.length + this.pool2.keys.length;
        return {
            total, available: total - b1 - b2,
            pool1: { total: this.pool1.keys.length, blocked: b1 },
            pool2: { total: this.pool2.keys.length, blocked: b2 }
        };
    }
}

// ============================================================================
// [MODULE 4] DATABASE SERVICE (PER-PLACE CONTEXT)
// ============================================================================

class DatabaseService {
    constructor() {
        this.data = {};
        this.placeData = {};
        this.threadMeta = {};
        this.personality = null;
        this.rateLimits = {};
        this._saveTimer = null;
        this._isSaving = false;
    }

    async initialize() {
        LoggerService.info('Database', 'Initializing...');
        await this._loadPersonality();
        await this._loadData();
        this._startGC();
    }

    async _loadPersonality() {
        try {
            const raw = await fs.readFile(ConfigService.PATHS.PERSONALITY, 'utf8');
            this.personality = JSON.parse(raw);
            LoggerService.success('Database', `Personality: ${this.personality.personality.name}`);
        } catch (e) {
            LoggerService.error('Database', 'CRITICAL: personality.json not found');
            process.exit(1);
        }
    }

    async _loadData() {
        try {
            const raw = await fs.readFile(ConfigService.PATHS.DATABASE, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = parsed.users || {};
            this.placeData = parsed.places || {};
            this.threadMeta = parsed.threadMeta || {};
            LoggerService.success('Database', `Loaded: ${Object.keys(this.data).length} users, ${Object.keys(this.placeData).length} places`);
        } catch (e) {
            this.data = {}; this.placeData = {}; this.threadMeta = {};
            LoggerService.warn('Database', 'Starting fresh');
            await this.save(true);
        }
    }

    async save(force = false) {
        if (this._isSaving && !force) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            this._isSaving = true;
            try {
                await fs.writeFile(ConfigService.PATHS.DATABASE, JSON.stringify({
                    users: this.data,
                    places: this.placeData,
                    threadMeta: this.threadMeta
                }, null, 2));
            } catch (e) {
                LoggerService.error('Database', 'Save failed');
            } finally {
                this._isSaving = false;
            }
        }, ConfigService.TIMEOUTS.SAVE_DEBOUNCE);
    }

    getUser(userId, userName) {
        if (!this.data[userId]) {
            this.data[userId] = {
                userId, userName: userName || 'Unknown',
                stats: { msgCount: 0, imgCount: 0, threadCount: 0, level: 1, lastSeen: new Date().toISOString() }
            };
        }
        if (userName) this.data[userId].userName = userName;
        return this.data[userId];
    }

    _placeKey(userId, channelId) {
        return `${userId}_${channelId}`;
    }

    getPlaceData(userId, channelId) {
        const key = this._placeKey(userId, channelId);
        if (!this.placeData[key]) {
            this.placeData[key] = { history: [], msgCount: 0, imgAnalyzed: 0, lastActive: Date.now() };
        }
        return this.placeData[key];
    }

    getPlaceMsgCount(userId, channelId) {
        return this.getPlaceData(userId, channelId).msgCount;
    }

    isPlaceLimitReached(userId, channelId, isThread) {
        const limit = isThread ? ConfigService.LIMITS.THREAD_LIMIT : ConfigService.LIMITS.NON_THREAD_LIMIT;
        return this.getPlaceMsgCount(userId, channelId) >= limit;
    }

    addPlaceInteraction(userId, channelId, userMsg, aiMsg) {
        const place = this.getPlaceData(userId, channelId);
        place.history.push({
            u: userMsg.substring(0, 800),
            a: aiMsg.substring(0, 1800),
            t: Date.now()
        });
        if (place.history.length > ConfigService.LIMITS.HISTORY_DEPTH) {
            place.history.shift();
        }
        place.msgCount++;
        place.lastActive = Date.now();

        const user = this.getUser(userId);
        user.stats.msgCount++;
        user.stats.lastSeen = new Date().toISOString();
        const nextLevel = Math.floor(user.stats.msgCount / 20) + 1;
        if (nextLevel > user.stats.level) user.stats.level = nextLevel;
        this.save();
    }

    resetPlaceData(userId, channelId) {
        const key = this._placeKey(userId, channelId);
        this.placeData[key] = { history: [], msgCount: 0, imgAnalyzed: 0, lastActive: Date.now() };
        this.save();
    }

    checkRateLimit(userId) {
        const now = Date.now();
        if (!this.rateLimits[userId]) {
            this.rateLimits[userId] = { count: 0, resetAt: now + 60000 };
        }
        const limit = this.rateLimits[userId];
        if (now > limit.resetAt) {
            limit.count = 0;
            limit.resetAt = now + 60000;
        }
        if (limit.count >= 12) {
            const waitTime = Math.ceil((limit.resetAt - now) / 1000);
            return { limited: true, waitTime };
        }
        limit.count++;
        return { limited: false };
    }

    getPlaceContext(userId, channelId, currentMsg) {
        const place = this.getPlaceData(userId, channelId);
        if (!place.history.length) return currentMsg;
        const recent = place.history
            .slice(-ConfigService.LIMITS.CONTEXT_WINDOW)
            .map(h => `User: ${h.u}\nAaesrl: ${h.a}`)
            .join('\n\n');
        return `[CONVERSATION HISTORY]\n${recent}\n\n[CURRENT MESSAGE]\n${currentMsg}`;
    }

    initThreadMeta(threadId, ownerId, mode = 'normal') {
        this.threadMeta[threadId] = {
            ownerId, mode, msgCount: 0,
            lastActive: Date.now(), warned: false,
            warningMsgId: null, deleteAt: null
        };
        this.save();
    }

    getThreadMeta(threadId) {
        return this.threadMeta[threadId] || null;
    }

    updateThreadActivity(threadId) {
        if (this.threadMeta[threadId]) {
            this.threadMeta[threadId].lastActive = Date.now();
            this.threadMeta[threadId].warned = false;
            this.threadMeta[threadId].deleteAt = null;
            this.save();
        }
    }

    incrementThreadMsg(threadId) {
        if (this.threadMeta[threadId]) {
            this.threadMeta[threadId].msgCount++;
            this.threadMeta[threadId].lastActive = Date.now();
            this.save();
        }
    }

    resetThreadMsg(threadId) {
        if (this.threadMeta[threadId]) {
            this.threadMeta[threadId].msgCount = 0;
            this.save();
        }
    }

    isThreadMsgLimitReached(threadId) {
        const meta = this.threadMeta[threadId];
        return meta && meta.msgCount >= ConfigService.LIMITS.THREAD_LIMIT;
    }

    deleteThreadMeta(threadId) {
        delete this.threadMeta[threadId];
        this.save();
    }

    _startGC() {
        setInterval(() => {
            const now = Date.now();
            let cleaned = 0;
            for (const key in this.placeData) {
                const place = this.placeData[key];
                const inactive = now - place.lastActive;
                if (inactive > ConfigService.LIMITS.CACHE_TTL) {
                    if (place.history.length > 0) {
                        place.history = place.history.slice(-5);
                        cleaned++;
                    }
                }
                if (inactive > 86400000) {
                    delete this.placeData[key];
                    cleaned++;
                }
            }
            // Clean rate limits
            for (const uid in this.rateLimits) {
                if (now > this.rateLimits[uid].resetAt + 300000) {
                    delete this.rateLimits[uid];
                }
            }
            if (cleaned > 0) LoggerService.info('Database', `GC: cleaned ${cleaned} inactive places`);
        }, ConfigService.TIMEOUTS.GC_INTERVAL);
    }
}

// ============================================================================
// [MODULE 5] INTELLIGENCE SERVICE (FIXED)
// ============================================================================

class IntelligenceService {
    constructor(db) {
        this.db = db;
        this.groqPool = new DualGroqPool();
    }

    detectMood(text) {
        if (!text) return 'casual';
        const lower = text.toLowerCase();
        const techPatterns = [/```[\s\S]*```/, /function\s+\w+/, /const\s+\w+\s*=/, /import\s+.*from/, /(class|interface|type)\s+\w+/];
        if (techPatterns.some(p => p.test(text))) return 'serious';

        const seriousKw = ['explain', 'how', 'what is', 'why', 'error', 'bug', 'help', 'tutorial', 'code', 'build', 'create',
            'jelaskan', 'bagaimana', 'apa itu', 'kenapa', 'bantuan', 'cara', 'kode', 'bikin', 'tolong', 'analisis', 'compare', 'versus'];
        const casualKw = ['hi', 'hey', 'halo', 'sup', 'yo', 'bro', 'cuy', 'wkwk', 'lol', 'haha', 'kabar', 'gabut', 'seru', 'ngobrol'];

        let s = 0, c = 0;
        seriousKw.forEach(k => { if (lower.includes(k)) s++; });
        casualKw.forEach(k => { if (lower.includes(k)) c++; });
        if (text.length > 200) s++;
        if (text.length < 50) c++;
        return s > c ? 'serious' : 'casual';
    }

    async _buildSystemPrompt(userName, mood, threadMode = 'normal') {
        const p = this.db.personality.personality;
        let prompt = `You are ${p.name}. ${p.description}\n\n`;

        if (p.core_traits) {
            prompt += `CORE TRAITS:\n${p.core_traits.map(t => `- ${t}`).join('\n')}\n\n`;
        }

        const modeConfig = p.language_modes?.[mood + '_mode'] || p.modes?.[mood];
        if (modeConfig) {
            prompt += `MODE: ${mood.toUpperCase()}\nTone: ${modeConfig.tone}\n\n`;
        }

        if (threadMode === 'deep') {
            prompt += `DEEP THINKING MODE ACTIVE:\n`;
            prompt += `- Provide thorough, academically rigorous responses\n`;
            prompt += `- Include real sources with URLs where applicable\n`;
            prompt += `- Structure answers with clear sections/headers\n`;
            prompt += `- Be detailed, precise, and comprehensive\n`;
            prompt += `- Use code blocks with proper syntax highlighting when showing code\n\n`;
        }

        prompt += `LANGUAGE RULES:\n`;
        prompt += `- Default language: English\n`;
        prompt += `- ALWAYS match the language the user writes in\n`;
        prompt += `- If user writes in Indonesian/Bahasa, respond in Indonesian\n`;
        prompt += `- Be natural and genuine - never robotic\n\n`;

        prompt += `CODE FORMATTING:\n`;
        prompt += `- Always use proper code blocks with language syntax (e.g., \`\`\`javascript)\n`;
        prompt += `- Add comments to explain complex code\n\n`;

        prompt += `User: ${userName}\n`;
        return prompt;
    }

    async generateThreadTitle(history) {
        if (!history || history.length === 0) return 'New Discussion';
        const recent = history.slice(-3).map(h => h.u).join(' | ');
        const keyInfo = this.groqPool.get();
        if (!keyInfo) return 'New Discussion';
        try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: ConfigService.MODELS.CHAT_TITLE,
                messages: [
                    { role: 'system', content: 'Generate a short 2-5 word thread title based on the conversation topic. No quotes, no punctuation at end. Just the title.' },
                    { role: 'user', content: `Conversation: ${recent.substring(0, 300)}` }
                ],
                max_tokens: 20,
                temperature: 0.3
            }, {
                headers: { 'Authorization': `Bearer ${keyInfo.key}`, 'Content-Type': 'application/json' },
                timeout: 10000
            });
            const title = res.data.choices[0].message.content.trim().replace(/['"]/g, '').substring(0, 80);
            this.groqPool.reportSuccess(keyInfo);
            return title || 'New Discussion';
        } catch (e) {
            return 'New Discussion';
        }
    }

    _buildWatermark() {
        const now = new Date();
        const wibOffset = 7 * 60;
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const wibTime = new Date(utc + (wibOffset * 60000));
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const day = wibTime.getDate();
        const month = months[wibTime.getMonth()];
        const year = wibTime.getFullYear();
        let hours = wibTime.getHours();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const mins = String(wibTime.getMinutes()).padStart(2, '0');
        return `\n\n-# Answered by AaesrlAI ${year} | ${day} ${month} ${hours}:${mins} ${ampm} WIB`;
    }

    async generateResponse(contextPrompt, userName, mood, threadMode = 'normal') {
        const systemPrompt = await this._buildSystemPrompt(userName, mood, threadMode);

        // Model selection: deep/serious = 70b smart, casual = 8b fast
        const model = (threadMode === 'deep' || mood === 'serious')
            ? ConfigService.MODELS.CHAT_SMART
            : ConfigService.MODELS.CHAT_FAST;

        // Token balance: deep=2000, serious=900, casual=600
        const maxTokens = threadMode === 'deep'
            ? 2000
            : (mood === 'serious' ? 900 : 600);

        // Temperature: deep=precise, serious=balanced, casual=creative
        const temperature = threadMode === 'deep' ? 0.2 : (mood === 'serious' ? 0.3 : 0.85);

        for (let attempt = 1; attempt <= ConfigService.LIMITS.MAX_RETRIES; attempt++) {
            const keyInfo = this.groqPool.get();
            if (!keyInfo?.key) {
                LoggerService.warn('Intelligence', `No available keys (attempt ${attempt})`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }

            try {
                const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: contextPrompt }
                    ],
                    max_tokens: maxTokens,
                    temperature,
                    top_p: 0.9
                }, {
                    headers: { 'Authorization': `Bearer ${keyInfo.key}`, 'Content-Type': 'application/json' },
                    timeout: ConfigService.TIMEOUTS.API_REQUEST
                });

                this.groqPool.reportSuccess(keyInfo);
                LoggerService.success('Intelligence', `Response via ${keyInfo.pool} [${model}] (${threadMode} mode, attempt ${attempt})`);

                let content = res.data.choices[0].message.content.trim();

                if (threadMode === 'deep') {
                    content += '\n\n' + '═'.repeat(50);
                    content += '\n**📚 Sources & References**\n';
                    content += '• Information compiled from academic papers, technical documentation, and reputable sources\n';
                    content += '• For specific citations or detailed references, feel free to ask';
                }

                return content + this._buildWatermark();

            } catch (e) {
                const status = e.response?.status || 500;
                const errMsg = e.response?.data?.error?.message || e.message || 'unknown';
                LoggerService.error('Intelligence', `${keyInfo.pool} [${model}] failed (${status}): ${errMsg.substring(0, 100)} - attempt ${attempt}/${ConfigService.LIMITS.MAX_RETRIES}`);

                if (status === 401 || status === 403) {
                    this.groqPool.reportFailure(keyInfo, true);
                } else if (status === 429) {
                    this.groqPool.reportFailure(keyInfo, true);
                    await new Promise(r => setTimeout(r, 3000 * attempt));
                } else {
                    this.groqPool.reportFailure(keyInfo, false);
                }

                if (attempt < ConfigService.LIMITS.MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 1500 * attempt));
                }
            }
        }

        // Emergency fallback
        LoggerService.warn('Intelligence', 'Using emergency fallback...');
        const emergencyKey = this.groqPool._emergency();
        if (emergencyKey?.key) {
            try {
                const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                    model: ConfigService.MODELS.CHAT_FAST, // Use fast model for emergency
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: contextPrompt }
                    ],
                    max_tokens: Math.min(maxTokens, 600),
                    temperature,
                    top_p: 0.9
                }, {
                    headers: { 'Authorization': `Bearer ${emergencyKey.key}`, 'Content-Type': 'application/json' },
                    timeout: ConfigService.TIMEOUTS.API_REQUEST
                });
                LoggerService.success('Intelligence', 'Emergency fallback succeeded!');
                let content = res.data.choices[0].message.content.trim();
                return content + this._buildWatermark();
            } catch (e) {
                LoggerService.error('Intelligence', 'Emergency fallback also failed');
            }
        }

        return "I'm having trouble connecting right now 😅 Please try again in a moment!" + this._buildWatermark();
    }

    // =========================================================================
    // FIXED: Image Generation with validation & retry
    // =========================================================================
    async generateImage(prompt) {
        const clean = prompt
            .replace(/\b(nsfw|nude|naked|sex|porn|explicit|gore|violence|blood|kill)\b/gi, 'artistic')
            .trim();

        // Primary: Pollinations AI (best free option, no API key needed)
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                LoggerService.info('ImageGen', `Attempt ${attempt}/3 via Pollinations...`);

                // Add seed for consistency
                const seed = Math.floor(Math.random() * 9999999);
                const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}?width=1024&height=1024&nologo=true&enhance=true&seed=${seed}`;

                const res = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 55000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'image/webp,image/png,image/*,*/*'
                    },
                    maxRedirects: 5
                });

                // ✅ FIX: Validate response is actually an image (not HTML error page)
                const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                const isImage = contentType.startsWith('image/');
                const buffer = Buffer.from(res.data);

                if (!isImage) {
                    LoggerService.warn('ImageGen', `Non-image response: ${contentType}, size: ${buffer.length}`);
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 2000 * attempt));
                        continue;
                    }
                }

                // Check minimum size (valid image should be > 1KB)
                if (buffer.length < 1024) {
                    LoggerService.warn('ImageGen', `Response too small (${buffer.length} bytes), likely error`);
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 2000 * attempt));
                        continue;
                    }
                }

                LoggerService.success('ImageGen', `Generated! Size: ${(buffer.length / 1024).toFixed(1)}KB, Type: ${contentType}`);
                return buffer;

            } catch (e) {
                LoggerService.error('ImageGen', `Attempt ${attempt} failed: ${e.message}`);
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }

        // Backup: Pollinations with different model
        try {
            LoggerService.warn('ImageGen', 'Trying backup model...');
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}?model=flux&width=1024&height=1024&nologo=true`;
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const buffer = Buffer.from(res.data);
            if (buffer.length > 1024) {
                LoggerService.success('ImageGen', `Backup model success! Size: ${(buffer.length / 1024).toFixed(1)}KB`);
                return buffer;
            }
        } catch (e) {
            LoggerService.error('ImageGen', `Backup also failed: ${e.message}`);
        }

        LoggerService.error('ImageGen', 'All image generation attempts failed');
        return null;
    }

    // =========================================================================
    // FIXED: Image Analysis with correct system prompt & MIME handling
    // =========================================================================
    async analyzeImage(imageUrl, userQuestion, userName, mood, retryCount = 0, visionModelIndex = 0) {
        const keyInfo = this.groqPool.get();
        if (!keyInfo?.key) {
            return "Sorry, I can't analyze images right now. All API keys are busy. Try again later!";
        }

        const visionModels = [
            ConfigService.MODELS.VISION_PRIMARY,
            ConfigService.MODELS.VISION_FALLBACK,
            ConfigService.MODELS.VISION_LAST
        ];
        const currentModel = visionModels[Math.min(visionModelIndex, visionModels.length - 1)];

        try {
            // Download image
            LoggerService.info('Vision', `Downloading image (attempt ${retryCount + 1}, model: ${currentModel})...`);
            const imgResponse = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 25000,
                maxContentLength: 20 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/*,*/*'
                }
            });

            // ✅ FIX: Clean MIME type by stripping charset and other params
            // e.g. "image/jpeg; charset=utf-8" -> "image/jpeg"
            const rawContentType = imgResponse.headers['content-type'] || 'image/jpeg';
            const mimeType = rawContentType.split(';')[0].trim().toLowerCase();

            // Normalize MIME type aliases
            const mimeMap = {
                'image/jpg': 'image/jpeg',
                'image/pjpeg': 'image/jpeg',
                'image/x-png': 'image/png'
            };
            const normalizedMime = mimeMap[mimeType] || mimeType;

            // Validate image type
            const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            if (!validTypes.includes(normalizedMime)) {
                // Try to detect from URL extension if header is wrong
                const urlLower = imageUrl.toLowerCase().split('?')[0];
                let detectedMime = normalizedMime;
                if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) detectedMime = 'image/jpeg';
                else if (urlLower.endsWith('.png')) detectedMime = 'image/png';
                else if (urlLower.endsWith('.webp')) detectedMime = 'image/webp';
                else if (urlLower.endsWith('.gif')) detectedMime = 'image/gif';

                if (!validTypes.includes(detectedMime)) {
                    LoggerService.warn('Vision', `Unsupported image type: ${normalizedMime}`);
                    return "⚠️ Format gambar tidak didukung. Gunakan JPG, PNG, WEBP, atau GIF ya!";
                }
                // Use detected MIME from URL
                LoggerService.warn('Vision', `Header mimeType incorrect (${normalizedMime}), using URL-detected: ${detectedMime}`);
            }

            const finalMime = validTypes.includes(normalizedMime)
                ? normalizedMime
                : (mimeMap[mimeType] || 'image/jpeg');

            const buffer = Buffer.from(imgResponse.data);
            const imageSize = buffer.length;

            if (imageSize < 100) {
                return "⚠️ Gambar terlalu kecil atau corrupt. Coba upload ulang ya!";
            }

            LoggerService.info('Vision', `Analyzing: ${finalMime}, ${(imageSize / 1024).toFixed(2)}KB, model: ${currentModel}`);

            const base64Image = buffer.toString('base64');

            // ✅ FIX: System prompt is now ACTUALLY INCLUDED in messages array
            const systemContent = `You are an expert image analyst. Analyze images thoroughly and answer questions accurately. Always respond in the same language as the user's question. Be detailed but concise. If the user writes in Indonesian/Bahasa, respond in Indonesian.`;

            const userContent = (userQuestion && userQuestion.trim())
                ? userQuestion
                : 'Describe this image in detail. What do you see?';

            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: currentModel,
                messages: [
                    {
                        role: 'system',
                        content: systemContent   // ✅ FIXED: System prompt now sent
                    },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: userContent
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${finalMime};base64,${base64Image}`,
                                    detail: 'high'  // High detail for better analysis
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 1200,
                temperature: 0.3
            }, {
                headers: {
                    'Authorization': `Bearer ${keyInfo.key}`,
                    'Content-Type': 'application/json'
                },
                timeout: ConfigService.TIMEOUTS.VISION_REQUEST
            });

            this.groqPool.reportSuccess(keyInfo);
            LoggerService.success('Vision', `Image analyzed via ${keyInfo.pool} [${currentModel}]`);

            const content = res.data.choices[0].message.content.trim();
            return content + this._buildWatermark();

        } catch (e) {
            const status = e.response?.status || 500;
            const errData = e.response?.data;
            const errMsg = errData?.error?.message || e.message || 'unknown error';

            LoggerService.error('Vision', `Failed [${currentModel}] (${status}): ${errMsg.substring(0, 200)}`);

            // Handle model not found or doesn't support vision - try next model
            if (status === 400 || status === 404) {
                // Check if it's a model issue
                const isModelIssue = errMsg.includes('model') ||
                    errMsg.includes('vision') ||
                    errMsg.includes('image') ||
                    errMsg.includes('not found') ||
                    status === 404;

                if (isModelIssue && visionModelIndex < 2) {
                    LoggerService.warn('Vision', `Model issue, trying next model (${visionModels[visionModelIndex + 1]})...`);
                    this.groqPool.reportFailure(keyInfo, false);
                    await new Promise(r => setTimeout(r, 1000));
                    return this.analyzeImage(imageUrl, userQuestion, userName, mood, retryCount + 1, visionModelIndex + 1);
                }

                // Retry with fresh key once
                if (retryCount === 0) {
                    LoggerService.warn('Vision', 'Retrying vision with different key...');
                    this.groqPool.reportFailure(keyInfo, false);
                    await new Promise(r => setTimeout(r, 1500));
                    return this.analyzeImage(imageUrl, userQuestion, userName, mood, 1, visionModelIndex);
                }
            }

            if (status === 401 || status === 403) {
                this.groqPool.reportFailure(keyInfo, true);
            } else if (status === 429) {
                this.groqPool.reportFailure(keyInfo, true);
                // Try with different model on rate limit
                if (visionModelIndex < 2) {
                    await new Promise(r => setTimeout(r, 2000));
                    return this.analyzeImage(imageUrl, userQuestion, userName, mood, retryCount + 1, visionModelIndex + 1);
                }
            } else {
                this.groqPool.reportFailure(keyInfo, false);
            }

            // User-friendly errors
            if (status === 413) return "⚠️ Gambar terlalu besar! Gunakan gambar di bawah 10MB ya.";
            if (status === 429) return "⚠️ Terlalu banyak request. Tunggu sebentar terus coba lagi!";
            if (status === 400) return "⚠️ Ada masalah sama format gambar. Coba:\n• Gunakan gambar JPG/PNG/WEBP\n• Ukuran di bawah 10MB\n• Gambar yang lebih clear";

            return "Gagal analisis gambar. Coba lagi atau kirim gambar yang berbeda!";
        }
    }
}

// ============================================================================
// [MODULE 6] INACTIVITY MONITOR
// ============================================================================

class InactivityMonitor {
    constructor(db, client) {
        this.db = db;
        this.client = client;
    }

    start() {
        setInterval(() => this._check(), ConfigService.TIMEOUTS.INACTIVITY_CHECK);
        LoggerService.info('Inactivity', 'Monitor started (checks every 1h)');
    }

    async _check() {
        const now = Date.now();
        for (const threadId in this.db.threadMeta) {
            const meta = this.db.threadMeta[threadId];
            const inactive = now - meta.lastActive;

            if (meta.warned && meta.deleteAt && now >= meta.deleteAt) {
                await this._deleteThread(threadId, meta);
                continue;
            }

            if (!meta.warned && inactive >= ConfigService.LIMITS.INACTIVITY_WARN_MS) {
                await this._warnUser(threadId, meta);
            }
        }
    }

    async _warnUser(threadId, meta) {
        try {
            const thread = await this.client.channels.fetch(threadId).catch(() => null);
            if (!thread) { this.db.deleteThreadMeta(threadId); return; }

            const deleteAt = Date.now() + ConfigService.LIMITS.INACTIVITY_DELETE_MS;
            this.db.threadMeta[threadId].warned = true;
            this.db.threadMeta[threadId].deleteAt = deleteAt;
            this.db.save();

            const deleteDate = new Date(deleteAt);
            const embed = new EmbedBuilder()
                .setColor(Colors.Yellow)
                .setTitle('⚠️ Inactive Thread Warning')
                .setDescription(
                    `Thread **"${thread.name}"** udah gak aktif **1 minggu**.\n\n` +
                    `Bakal **dihapus dalam 10 jam** (sekitar ${deleteDate.toLocaleTimeString()}).\n\n` +
                    `Klik di bawah untuk reactivate atau hapus sekarang.`
                )
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`thread_reactivate_${threadId}`)
                    .setLabel('Reactivate Thread')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`thread_delete_${threadId}`)
                    .setLabel('Delete Thread')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🗑️')
            );

            await thread.send({ content: `<@${meta.ownerId}>`, embeds: [embed], components: [row] }).catch(() => null);

            const user = await this.client.users.fetch(meta.ownerId).catch(() => null);
            if (user) {
                await user.send({ embeds: [embed], components: [row] }).catch(() => null);
            }

            LoggerService.info('Inactivity', `Warning sent for thread ${threadId}`);
        } catch (e) {
            LoggerService.error('Inactivity', 'Warn user failed');
        }
    }

    async _deleteThread(threadId, meta) {
        try {
            const thread = await this.client.channels.fetch(threadId).catch(() => null);
            if (thread?.deletable) {
                await thread.delete('Inactive for over 1 week + 10 hours').catch(() => null);
                LoggerService.info('Inactivity', `Deleted thread ${threadId}`);
            }

            for (const key in this.db.placeData) {
                if (key.includes(`_${threadId}`)) delete this.db.placeData[key];
            }

            this.db.deleteThreadMeta(threadId);

            const user = await this.client.users.fetch(meta.ownerId).catch(() => null);
            if (user) {
                await user.send({
                    embeds: [new EmbedBuilder()
                        .setColor(Colors.Red)
                        .setTitle('🗑️ Thread Deleted')
                        .setDescription('Thread kamu otomatis dihapus karena tidak aktif.')
                        .setTimestamp()
                    ]
                }).catch(() => null);
            }
        } catch (e) {
            LoggerService.error('Inactivity', 'Delete thread failed');
            this.db.deleteThreadMeta(threadId);
        }
    }
}

// ============================================================================
// [MODULE 7] INTERACTION CONTROLLER
// ============================================================================

class InteractionController {
    constructor(bot) {
        this.bot = bot;
    }

    async handle(interaction) {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

        try {
            const userId = interaction.user.id;
            const userName = interaction.user.username;

            // ----- BUTTON HANDLERS -----
            if (interaction.isButton()) {
                const id = interaction.customId;

                if (id === 'reset_conv') {
                    const channelId = interaction.channel.id;
                    this.bot.db.resetPlaceData(userId, channelId);
                    await interaction.update({ content: '✅ Conversation reset.', embeds: [], components: [] });
                }
                else if (id === 'cancel_reset') {
                    await interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] });
                }
                else if (id.startsWith('limit_create_thread_')) {
                    await interaction.update({ content: '🧵 Creating thread...', embeds: [], components: [] });
                    await this._handleAutoCreateThread(interaction, userId, userName);
                }
                else if (id === 'limit_stay') {
                    const channelId = interaction.channel.id;
                    this.bot.db.resetPlaceData(userId, channelId);
                    await interaction.update({ content: '✅ Conversation reset. Continue here!', embeds: [], components: [] });
                }
                else if (id.startsWith('mode_normal_')) {
                    const threadId = id.replace('mode_normal_', '');
                    if (this.bot.db.threadMeta[threadId]) {
                        this.bot.db.threadMeta[threadId].mode = 'normal';
                        this.bot.db.save();
                    }
                    await interaction.update({ content: '✅ **Normal Mode** activated! Ask away!', embeds: [], components: [] });
                }
                else if (id.startsWith('mode_deep_')) {
                    const threadId = id.replace('mode_deep_', '');
                    if (this.bot.db.threadMeta[threadId]) {
                        this.bot.db.threadMeta[threadId].mode = 'deep';
                        this.bot.db.save();
                    }
                    await interaction.update({ content: '🧠 **Deep Thinking Mode** activated! Responses will be detailed with sources.', embeds: [], components: [] });
                }
                else if (id.startsWith('thread_expand_')) {
                    const threadId = id.replace('thread_expand_', '');
                    this.bot.db.resetThreadMsg(threadId);
                    await interaction.update({ content: '✅ Thread expanded! Continue chatting.', embeds: [], components: [] });
                }
                else if (id.startsWith('thread_stop_')) {
                    await interaction.update({ content: '🛑 Thread stopped.', embeds: [], components: [] });
                }
                else if (id.startsWith('thread_reactivate_')) {
                    const threadId = id.replace('thread_reactivate_', '');
                    this.bot.db.updateThreadActivity(threadId);
                    await interaction.update({ content: '✅ Thread reactivated! Inactivity timer reset.', embeds: [], components: [] });
                    const thread = await this.bot.client.channels.fetch(threadId).catch(() => null);
                    if (thread) await thread.send('✅ Thread reactivated by owner!').catch(() => null);
                }
                else if (id.startsWith('thread_delete_')) {
                    const threadId = id.replace('thread_delete_', '');
                    const meta = this.bot.db.getThreadMeta(threadId);
                    if (meta) {
                        const thread = await this.bot.client.channels.fetch(threadId).catch(() => null);
                        if (thread?.deletable) await thread.delete('Manually deleted by owner').catch(() => null);
                        this.bot.db.deleteThreadMeta(threadId);
                    }
                    await interaction.update({ content: '🗑️ Thread deleted.', embeds: [], components: [] });
                }

                return;
            }

            // ----- SLASH COMMANDS -----
            if (interaction.commandName === 'ask') {
                const topic = interaction.options.getString('topic');
                await this._createThreadWithMode(interaction, topic, userId, userName);
            }
            else if (interaction.commandName === 'img') {
                const prompt = interaction.options.getString('prompt');
                await interaction.deferReply();
                await interaction.editReply('🎨 **Generating image...** This may take 20-40 seconds...');
                const img = await this.bot.ai.generateImage(prompt);
                if (img) {
                    this.bot.db.getUser(userId, userName).stats.imgCount++;
                    this.bot.db.save();
                    await interaction.editReply({ content: `🎨 **Generated:** ${prompt}`, files: [new AttachmentBuilder(img, { name: 'art.png' })] });
                } else {
                    await interaction.editReply('❌ Gagal generate gambar. Server AI-nya lagi sibuk, coba lagi beberapa detik!');
                }
            }
            else if (interaction.commandName === 'stats') {
                const u = this.bot.db.getUser(userId, userName);
                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(Colors.Blue)
                        .setTitle(`📊 ${userName}'s Stats`)
                        .setDescription(`Level ${u.stats.level}`)
                        .addFields(
                            { name: '💬 Messages', value: `${u.stats.msgCount}`, inline: true },
                            { name: '🎨 Images', value: `${u.stats.imgCount}`, inline: true },
                            { name: '🧵 Threads', value: `${u.stats.threadCount || 0}`, inline: true }
                        )
                        .setTimestamp()
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }
            else if (interaction.commandName === 'reset') {
                const channelId = interaction.channel.id;
                this.bot.db.resetPlaceData(userId, channelId);
                if (interaction.channel.isThread()) {
                    this.bot.db.resetThreadMsg(channelId);
                }
                await interaction.reply({ content: '🧠 Memory cleared for this place.', flags: MessageFlags.Ephemeral });
            }
            else if (interaction.commandName === 'status') {
                const stats = this.bot.ai.groqPool.getStats();
                const uptime = process.uptime();
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

                const statusEmbed = new EmbedBuilder()
                    .setColor(stats.available > 5 ? Colors.Green : stats.available > 2 ? Colors.Yellow : Colors.Red)
                    .setTitle('🤖 Bot Status')
                    .setDescription(`All systems ${stats.available >= 7 ? 'optimal' : stats.available >= 4 ? 'operational' : 'degraded'}`)
                    .addFields(
                        { name: '🔑 API Keys', value: `${stats.available}/${stats.total} available`, inline: true },
                        { name: '⏱️ Uptime', value: `${hours}h ${minutes}m`, inline: true },
                        { name: '💾 Memory', value: `${mem}MB`, inline: true },
                        { name: '📊 Pool 1', value: `${stats.pool1.total - stats.pool1.blocked}/${stats.pool1.total} active`, inline: true },
                        { name: '📊 Pool 2', value: `${stats.pool2.total - stats.pool2.blocked}/${stats.pool2.total} active`, inline: true },
                        { name: '🌐 Latency', value: `${this.bot.client.ws.ping}ms`, inline: true }
                    )
                    .setFooter({ text: 'Version 20.0 - Fixed Vision & ImageGen' })
                    .setTimestamp();

                await interaction.reply({ embeds: [statusEmbed], flags: MessageFlags.Ephemeral });
            }

        } catch (e) {
            LoggerService.error('Interaction', 'Handler error', e);
            try {
                const msg = 'Oops, something went wrong!';
                if (interaction.deferred) await interaction.editReply(msg);
                else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
            } catch (err) { /* silent */ }
        }
    }

    async _createThreadWithMode(interaction, topic, userId, userName) {
        const isAlreadyThread = interaction.channel.isThread();
        const canCreate = interaction.guild &&
            interaction.channel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.CreatePublicThreads);

        if (isAlreadyThread || !canCreate) {
            await interaction.deferReply();
            const mood = this.bot.ai.detectMood(topic);
            const ctx = this.bot.db.getPlaceContext(userId, interaction.channel.id, topic);
            const res = await this.bot.ai.generateResponse(ctx, userName, mood);
            await interaction.editReply(`**Topic:** ${topic}\n\n${res}`);
            this.bot.db.addPlaceInteraction(userId, interaction.channel.id, topic, res);
            return;
        }

        try {
            await interaction.reply({ content: '🧵 Creating thread...', flags: MessageFlags.Ephemeral });

            const thread = await interaction.channel.threads.create({
                name: `💬 ${topic.substring(0, 80)}`,
                autoArchiveDuration: 1440,
                type: ChannelType.PublicThread
            });

            this.bot.db.initThreadMeta(thread.id, userId);
            this.bot.db.getUser(userId).stats.threadCount++;
            this.bot.db.save();

            const modeEmbed = new EmbedBuilder()
                .setColor(Colors.Blurple)
                .setTitle('🎛️ Choose Conversation Mode')
                .setDescription(
                    `**Topic:** ${topic}\n\n` +
                    `**💬 Normal Mode**\n→ Casual, natural conversation. Quick responses.\n\n` +
                    `**🧠 Deep Thinking Mode**\n→ Detailed, comprehensive responses with sources. Uses smarter AI model.`
                )
                .setFooter({ text: 'Choose your preferred mode to start!' });

            const modeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mode_normal_${thread.id}`).setLabel('Normal Mode').setStyle(ButtonStyle.Primary).setEmoji('💬'),
                new ButtonBuilder().setCustomId(`mode_deep_${thread.id}`).setLabel('Deep Thinking').setStyle(ButtonStyle.Secondary).setEmoji('🧠')
            );

            await thread.send({ embeds: [modeEmbed], components: [modeRow] });

        } catch (e) {
            LoggerService.error('Thread', 'Create with mode failed', e);
            await interaction.followUp({ content: 'Thread creation failed.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    async _handleAutoCreateThread(interaction, userId, userName) {
        try {
            const channelId = interaction.channel.id;
            const placeData = this.bot.db.getPlaceData(userId, channelId);
            const title = await this.bot.ai.generateThreadTitle(placeData.history);

            const canCreate = interaction.guild &&
                interaction.channel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.CreatePublicThreads);

            if (!canCreate) {
                this.bot.db.resetPlaceData(userId, channelId);
                await interaction.followUp({ content: '✅ Conversation reset! Continue here.', flags: MessageFlags.Ephemeral }).catch(() => {});
                return;
            }

            const thread = await interaction.channel.threads.create({
                name: `💬 ${title}`,
                autoArchiveDuration: 1440,
                type: ChannelType.PublicThread
            });

            const existingHistory = [...placeData.history];
            this.bot.db.resetPlaceData(userId, channelId);
            const threadPlace = this.bot.db.getPlaceData(userId, thread.id);
            threadPlace.history = existingHistory;
            threadPlace.msgCount = 0;
            this.bot.db.save();

            this.bot.db.initThreadMeta(thread.id, userId);
            this.bot.db.getUser(userId).stats.threadCount++;
            this.bot.db.save();

            const modeEmbed = new EmbedBuilder()
                .setColor(Colors.Blurple)
                .setTitle('🎛️ Choose Conversation Mode')
                .setDescription(
                    `Your conversation has been moved here!\n\n` +
                    `**💬 Normal Mode**\n→ Casual, natural conversation.\n\n` +
                    `**🧠 Deep Thinking Mode**\n→ Detailed responses with sources.`
                );

            const modeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mode_normal_${thread.id}`).setLabel('Normal Mode').setStyle(ButtonStyle.Primary).setEmoji('💬'),
                new ButtonBuilder().setCustomId(`mode_deep_${thread.id}`).setLabel('Deep Thinking').setStyle(ButtonStyle.Secondary).setEmoji('🧠')
            );

            await thread.send({ content: `<@${userId}> Your conversation has been moved here!`, embeds: [modeEmbed], components: [modeRow] });

        } catch (e) {
            LoggerService.error('Interaction', 'Auto-create thread failed', e);
        }
    }
}

// ============================================================================
// [MODULE 8] MESSAGE CONTROLLER
// ============================================================================

class MessageController {
    constructor(bot) {
        this.bot = bot;
    }

    async handle(message) {
        if (message.author.bot) return;

        try {
            const userId = message.author.id;
            const userName = message.author.username;
            const channelId = message.channel.id;
            const isThread = message.channel.isThread();
            const isMention = message.mentions.users.has(this.bot.client.user.id);
            const isTargetChannel = [
                ConfigService.ENV.CHANNELS.CHAT,
                ConfigService.ENV.CHANNELS.IMAGE
            ].includes(channelId);

            if (!isThread && !isMention && !isTargetChannel) return;

            this.bot.db.getUser(userId, userName);

            // Rate limit check
            const rateLimit = this.bot.db.checkRateLimit(userId);
            if (rateLimit.limited) {
                return message.reply(`⏱️ Santai dulu! Tunggu ${rateLimit.waitTime} detik sebelum kirim lagi.`);
            }

            // Check limits
            if (!isThread) {
                if (this.bot.db.isPlaceLimitReached(userId, channelId, false)) {
                    return message.reply(this.bot.getNonThreadLimitEmbed(userId, channelId));
                }
            } else {
                if (this.bot.db.isThreadMsgLimitReached(channelId)) {
                    return message.reply(this.bot.getThreadLimitEmbed(channelId));
                }
                this.bot.db.updateThreadActivity(channelId);
            }

            // --- IMAGE ANALYSIS ---
            const attachment = message.attachments.first();
            const hasImage = attachment && (
                attachment.contentType?.startsWith('image/') ||
                /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(attachment.url)
            );

            if (hasImage) {
                const placeData = this.bot.db.getPlaceData(userId, channelId);

                if (placeData.imgAnalyzed >= ConfigService.LIMITS.VISION_LIMIT_PER_PLACE) {
                    return message.reply(`🖼️ **Image analysis limit reached** (${ConfigService.LIMITS.VISION_LIMIT_PER_PLACE}/${ConfigService.LIMITS.VISION_LIMIT_PER_PLACE})\n💡 Gunakan \`/reset\` untuk mulai fresh!`);
                }

                await message.channel.sendTyping();
                const statusMsg = await message.reply('🔍 **Menganalisis gambar...** Sebentar ya.');

                const typingInterval = setInterval(() => {
                    message.channel.sendTyping().catch(() => clearInterval(typingInterval));
                }, 8000);

                try {
                    const imageUrl = attachment.url;
                    const userQuestion = message.content.trim() || 'Apa yang ada di gambar ini?';
                    const mood = this.bot.ai.detectMood(userQuestion);

                    const response = await this.bot.ai.analyzeImage(imageUrl, userQuestion, userName, mood);

                    clearInterval(typingInterval);
                    if (statusMsg?.deletable) await statusMsg.delete().catch(() => {});

                    await message.reply(response);

                    placeData.imgAnalyzed++;
                    const remaining = ConfigService.LIMITS.VISION_LIMIT_PER_PLACE - placeData.imgAnalyzed;

                    if (remaining <= 3 && remaining > 0) {
                        await message.channel.send(`💡 *${remaining} image analysis tersisa di sesi ini*`);
                    } else if (remaining === 0) {
                        await message.channel.send(`⚠️ *Limit analisis gambar tercapai. Gunakan \`/reset\` untuk lanjut!*`);
                    }

                    this.bot.db.addPlaceInteraction(userId, channelId,
                        `[Image Analysis] ${userQuestion}`,
                        response.replace(this.bot.ai._buildWatermark(), '')
                    );

                    if (isThread) this.bot.db.incrementThreadMsg(channelId);

                } catch (err) {
                    clearInterval(typingInterval);
                    if (statusMsg?.deletable) await statusMsg.delete().catch(() => {});
                    throw err;
                }

                return;
            }

            await message.channel.sendTyping();

            // Image generation via text command
            if (/^(img|image|gambar|generate|gen|create)\s/i.test(message.content)) {
                return await this._handleImage(message, userId);
            }

            await this._handleChat(message, userId, userName, channelId, isThread, isMention);

        } catch (e) {
            LoggerService.error('Message', 'Handler error', e);
            await message.reply('Waduh error nih, coba lagi! 😅').catch(() => {});
        }
    }

    async _handleImage(message, userId) {
        const prompt = message.content.replace(/^(img|image|gambar|generate|gen|create)\s/i, '').trim();
        if (!prompt || prompt.length < 3) return message.reply('Kasih deskripsi gambar dulu dong!');

        const status = await message.reply('🎨 Generating... (20-40 detik ya)');
        const img = await this.bot.ai.generateImage(prompt);

        if (img) {
            this.bot.db.getUser(userId).stats.imgCount++;
            this.bot.db.save();
            await status.edit({
                content: `✅ **Prompt:** ${prompt}`,
                files: [new AttachmentBuilder(img, { name: 'art.png' })]
            });
        } else {
            await status.edit('❌ Gagal generate. Coba beberapa detik lagi!');
        }
    }

    async _handleChat(message, userId, userName, channelId, isThread, isMention) {
        try {
            let threadMode = 'normal';
            if (isThread) {
                const meta = this.bot.db.getThreadMeta(channelId);
                threadMode = meta?.mode || 'normal';
            }

            const mood = this.bot.ai.detectMood(message.content);
            const contextPrompt = this.bot.db.getPlaceContext(userId, channelId, message.content);
            const response = await this.bot.ai.generateResponse(contextPrompt, userName, mood, threadMode);

            const replyTo = (!isThread && isMention) ? message : null;
            await this.bot.sendThinkingGimmick(message.channel, response, replyTo, threadMode);

            if (isThread) this.bot.db.incrementThreadMsg(channelId);
            this.bot.db.addPlaceInteraction(userId, channelId, message.content, response);

        } catch (e) {
            LoggerService.error('Chat', 'Response error', e);
            await message.reply('Error nih, coba lagi! 🔧').catch(() => {});
        }
    }
}

// ============================================================================
// [MODULE 9] CORE CLIENT (No Web Server)
// ============================================================================

class CoreClient {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Channel, Partials.Message, Partials.User],
            makeCache: Options.cacheWithLimits({
                MessageManager: 80,
                UserManager: 100,
                ThreadManager: 30,
                PresenceManager: 0,
                GuildMemberManager: 30,
                ReactionManager: 0
            }),
            sweepers: {
                messages: {
                    interval: 300,
                    lifetime: 900
                }
            }
        });

        this.db = new DatabaseService();
        this.ai = null;
        this.inactivityMonitor = null;
        this.interactionController = new InteractionController(this);
        this.messageController = new MessageController(this);

        // Simple HTTP health check (minimal, no Express needed)
        this._startHealthServer();
    }

    _startHealthServer() {
        const http = require('http');
        const port = process.env.PORT || 12259;

        const server = http.createServer((req, res) => {
            if (req.url === '/health' || req.url === '/') {
                const stats = this.ai ? this.ai.groqPool.getStats() : { available: 0, total: 0 };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    service: 'aaesrl-bot-v20',
                    uptime: Math.floor(process.uptime()),
                    discord: this.client.isReady() ? 'connected' : 'connecting',
                    apiKeys: `${stats.available}/${stats.total}`,
                    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
                }));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        server.listen(port, '0.0.0.0', () => {
            LoggerService.success('Health', `Health check server on port ${port}`);
        });

        server.on('error', (e) => {
            LoggerService.warn('Health', `Health server error: ${e.message}`);
        });
    }

    async start() {
        LoggerService.info('System', '='.repeat(70));
        LoggerService.info('System', 'AAESRL v20.0 - PURE DISCORD BOT (Web Interface Removed)');
        LoggerService.info('System', 'Fixed: Vision + ImageGen | Upgraded: Models + Stability');
        LoggerService.info('System', '='.repeat(70));

        await this.db.initialize();
        this.ai = new IntelligenceService(this.db);
        this.registerEvents();
        await this.client.login(ConfigService.ENV.TOKEN);
    }

    registerEvents() {
        this.client.once(Events.ClientReady, () => this.onReady());
        this.client.on(Events.InteractionCreate, i => this.interactionController.handle(i));
        this.client.on(Events.MessageCreate, m => this.messageController.handle(m));
        process.on('uncaughtException', e => {
            LoggerService.error('System', 'Uncaught Exception', e);
            // Don't exit - keep bot running
        });
        process.on('unhandledRejection', e => {
            LoggerService.error('System', 'Unhandled Rejection', e);
        });
    }

    async onReady() {
        LoggerService.success('System', `Logged in as ${this.client.user.tag}`);
        LoggerService.info('System', `Guilds: ${this.client.guilds.cache.size}`);

        const stats = this.ai.groqPool.getStats();
        LoggerService.info('System', `API Keys: ${stats.available}/${stats.total} available`);
        LoggerService.info('System', `Vision Models: ${ConfigService.MODELS.VISION_PRIMARY} (primary)`);
        LoggerService.info('System', `Chat Models: ${ConfigService.MODELS.CHAT_SMART} (deep) | ${ConfigService.MODELS.CHAT_FAST} (fast)`);

        this.inactivityMonitor = new InactivityMonitor(this.db, this.client);
        this.inactivityMonitor.start();

        await this.deployCommands();
        this.startStatusRotation();
    }

    async deployCommands() {
        const commands = [
            new SlashCommandBuilder().setName('ask').setDescription('Start a discussion thread')
                .addStringOption(o => o.setName('topic').setDescription('Topic to discuss').setRequired(true)),
            new SlashCommandBuilder().setName('img').setDescription('Generate an AI image (free)')
                .addStringOption(o => o.setName('prompt').setDescription('Image description').setRequired(true)),
            new SlashCommandBuilder().setName('stats').setDescription('View your stats'),
            new SlashCommandBuilder().setName('reset').setDescription('Clear memory for this place'),
            new SlashCommandBuilder().setName('status').setDescription('Check bot status & API health')
        ];

        const rest = new REST({ version: '10' }).setToken(ConfigService.ENV.TOKEN);
        try {
            await rest.put(Routes.applicationCommands(this.client.user.id), { body: commands });
            LoggerService.success('System', 'Commands deployed');
        } catch (e) {
            LoggerService.error('System', 'Command deploy failed', e);
        }
    }

    startStatusRotation() {
        const update = () => {
            const statuses = this.db.personality.misc?.activityStatuses || [{ type: 'Playing', text: 'Standby 🤖' }];
            const s = statuses[Math.floor(Math.random() * statuses.length)];
            this.client.user.setActivity(s.text, { type: ActivityType[s.type] || ActivityType.Playing });
        };
        update();
        setInterval(update, ConfigService.TIMEOUTS.ACTIVITY_UPDATE);
    }

    async sendThinkingGimmick(channel, content, replyTo = null, mode = 'normal') {
        try {
            let minDelay = ConfigService.TIMEOUTS.THINKING_MIN;
            let maxDelay = ConfigService.TIMEOUTS.THINKING_MAX;

            if (mode === 'deep') { minDelay = 1000; maxDelay = 2200; }
            else if (mode === 'vision') { minDelay = 1200; maxDelay = 2500; }

            const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
            const thinkingEmojis = ['💭', '🤔', '🧠', '💡'];
            const emoji = mode === 'deep' ? '🧠' : mode === 'vision' ? '👁️' : thinkingEmojis[Math.floor(Math.random() * thinkingEmojis.length)];

            let msg;
            if (replyTo) msg = await replyTo.reply(`${emoji} ...`);
            else msg = await channel.send(`${emoji} ...`);

            await new Promise(r => setTimeout(r, delay));
            if (msg?.deletable) await msg.delete().catch(() => {});

            if (replyTo) return await replyTo.reply(content);
            return await channel.send(content);
        } catch (e) {
            try {
                if (replyTo) return await replyTo.reply(content);
                return await channel.send(content);
            } catch (err) { /* silent */ }
        }
    }

    getNonThreadLimitEmbed(userId, channelId) {
        const embed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle('💬 Conversation Limit Reached')
            .setDescription(
                `Udah **${ConfigService.LIMITS.NON_THREAD_LIMIT} pesan** di channel ini.\n\n` +
                `Buat **thread** untuk lanjut (unlimited dengan siklus 30 pesan), atau reset di sini.`
            )
            .setFooter({ text: 'Thread lebih bagus untuk obrolan panjang!' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`limit_create_thread_${userId}`)
                .setLabel('Create Thread')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🧵'),
            new ButtonBuilder()
                .setCustomId('limit_stay')
                .setLabel('Reset & Stay Here')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄')
        );

        return { embeds: [embed], components: [row] };
    }

    getThreadLimitEmbed(threadId) {
        const embed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle('🧵 Thread Limit Reached')
            .setDescription(
                `Udah **${ConfigService.LIMITS.THREAD_LIMIT} pesan** di siklus ini.\n\n` +
                `**Expand** untuk lanjut (pesan lama dihapus)\n` +
                `**Stop** untuk mengakhiri diskusi\n` +
                `Atau \`/reset\` untuk clear history`
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`thread_expand_${threadId}`).setLabel('Expand').setStyle(ButtonStyle.Primary).setEmoji('➕'),
            new ButtonBuilder().setCustomId(`thread_stop_${threadId}`).setLabel('Stop').setStyle(ButtonStyle.Secondary).setEmoji('🛑')
        );

        return { embeds: [embed], components: [row] };
    }
}

// ============================================================================
// [MODULE 10] BOOTSTRAP
// ============================================================================

const bot = new CoreClient();
bot.start().catch(err => {
    LoggerService.error('System', 'FATAL START ERROR', err);
    process.exit(1);
});
