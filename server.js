require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
const DATA_FILE = './data.json';

// ================= [ 데이터 파일 관리 ] =================
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const initialData = { blacklistedGuilds: [], blacklistedIPs: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================= [ 디스코드 봇 기능 통합 ] =================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`🤖 통합 봇 로그인 성공: ${client.user.tag}`);
});

// 봇 명령어 (예: !블랙서버 추가 [서버ID])
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.split(' ');
    const cmd = args[0];

    if (cmd === '!블랙서버') {
        const sub = args[1]; 
        const targetId = args[2];
        const data = loadData();

        if (sub === '추가' && targetId) {
            if (!data.blacklistedGuilds.includes(targetId)) {
                data.blacklistedGuilds.push(targetId);
                saveData(data);
                return message.reply(`✅ 서버 ID \`${targetId}\`가 블랙리스트에 추가되었습니다.`);
            } else {
                return message.reply(`⚠️ 이미 블랙리스트에 등록된 서버 ID입니다.`);
            }
        } else if (sub === '제거' && targetId) {
            data.blacklistedGuilds = data.blacklistedGuilds.filter(id => id !== targetId);
            saveData(data);
            return message.reply(`🗑️ 서버 ID \`${targetId}\`가 블랙리스트에서 제거되었습니다.`);
        } else if (sub === '목록') {
            return message.reply(`📋 현재 차단된 서버 ID 목록:\n\`\`\`json\n${JSON.stringify(data.blacklistedGuilds, null, 2)}\n\`\`\``);
        } else {
            return message.reply(`사용법: \`!블랙서버 추가 [서버ID]\`, \`!블랙서버 제거 [서버ID]\`, \`!블랙서버 목록\``);
        }
    }
});

// 디스코드 봇 로그인 실행
client.login(process.env.DISCORD_BOT_TOKEN);

// ================= [ 디스코드 채널로 로그 전송 함수 ] =================
async function sendDiscordLog(title, color, fields) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_LOG_CHANNEL_ID;

    if (!botToken || !channelId) return;

    try {
        await axios.post(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            {
                embeds: [{
                    title: title,
                    color: color,
                    fields: fields,
                    timestamp: new Date().toISOString()
                }]
            },
            {
                headers: {
                    'Authorization': `Bot ${botToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (err) {
        console.error('🤖 봇 로그 전송 실패:', err.response?.data || err.message);
    }
}

// ================= [ 세션 및 IP 설정 ] =================
app.use(session({
    secret: process.env.SESSION_SECRET || 'super_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
           req.headers['cf-connecting-ip'] || 
           req.socket.remoteAddress;
}

// 영구 차단된 IP 미들웨어
app.use((req, res, next) => {
    const ip = getClientIp(req);
    const data = loadData();
    
    if (data.blacklistedIPs.includes(ip)) {
        return res.status(403).send(`
            <div style="text-align:center; padding: 50px; font-family: sans-serif;">
                <h1 style="color: red;">[접속 차단됨]</h1>
                <p>귀하의 IP(<b>${ip}</b>)는 보안 정책에 의해 영구 차단되었습니다.</p>
            </div>
        `);
    }
    next();
});

// ================= [ 라우터 설정 ] =================

// 1. 최초 접속 시 뜨는 IP 동의서 화면 OR 인증 완료 화면
app.get('/', (req, res) => {
    if (req.session.user) {
        return res.send(`
            <div style="text-align:center; padding: 50px; font-family: sans-serif;">
                <h2>동의를 눌렀습니다.</h2>
                <p style="font-size: 24px;">귀하의 접속 IP: <b>${req.session.user.ip}</b></p>
                <h1 style="color: #4CAF50; font-size: 40px;">인증완료!</h1>
                <p>✅ <b>서버장(디스코드 관리자 채널)에게 인증 정보가 정상적으로 전달되었습니다.</b></p>
            </div>
        `);
    }

    res.send(`
        <div style="text-align:center; padding: 50px; font-family: sans-serif;">
            <h1 style="font-size: 50px; color: #333; margin-bottom: 10px;">IP 관련 동의서</h1>
            
            <div style="border: 2px solid #ccc; padding: 30px; max-width: 600px; margin: 0 auto; text-align: center; background-color: #f9f9f9; border-radius: 10px;">
                <p style="font-size: 18px; color: #d32f2f; font-weight: bold;">[ 중요 안내 ]</p>
                <p style="font-size: 16px; line-height: 1.6;">
                    본 인증 시스템은 악성 유저 및 블랙리스트를 차단하기 위해<br>
                    <b>실제로 귀하의 IP 주소를 수집하여 서버장에게 전송</b>합니다.
                </p>
                <p style="font-size: 16px; line-height: 1.6; color: red; font-weight: bold;">
                    🚫 IP 우회를 위한 VPN, 프록시(Proxy), Tor 브라우저의 사용이 엄격히 금지됩니다. 적발 시 즉시 차단됩니다.
                </p>
                <p style="font-size: 14px; color: #666;">
                    이에 동의하실 경우에만 아래 '동의' 버튼을 눌러 인증을 진행해 주세요.
                </p>
            </div>
            
            <div style="margin-top: 30px;">
                <a href="/auth/discord" style="text-decoration: none;">
                    <button style="padding: 15px 40px; font-size: 20px; font-weight: bold; cursor: pointer; background-color: #4CAF50; color: white; border: none; border-radius: 5px; margin-right: 20px;">동의 (인증하기)</button>
                </a>
                <a href="/decline" style="text-decoration: none;">
                    <button style="padding: 15px 40px; font-size: 20px; font-weight: bold; cursor: pointer; background-color: #f44336; color: white; border: none; border-radius: 5px;">미동의</button>
                </a>
            </div>
        </div>
    `);
});

// 2. 미동의 버튼 눌렀을 때 (IP 전달 안 함)
app.get('/decline', (req, res) => {
    res.send(`
        <div style="text-align:center; padding: 50px; font-family: sans-serif;">
            <h1 style="color: red;">미동의를 눌렀습니다.</h1>
            <p>IP 수집 및 정책에 동의하지 않아 인증 절차가 취소되었습니다.</p>
            <p><b>서버장에게 귀하의 IP나 어떠한 정보도 전달되지 않았습니다.</b></p>
            <br>
            <a href="/"><button style="padding: 10px 20px; cursor: pointer;">처음으로 돌아가기</button></a>
        </div>
    `);
});

app.get('/auth/discord', (req, res) => {
    const redirectUrl = `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
    res.redirect(redirectUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    const ip = getClientIp(req);

    if (!code) return res.status(400).send('인증 코드가 없습니다.');

    try {
        const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const token = tokenRes.data.access_token;
        const user = (await axios.get('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token}` } })).data;
        const guilds = (await axios.get('https://discord.com/api/v10/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } })).data;

        const data = loadData();
        const bannedGuilds = guilds.filter(g => data.blacklistedGuilds.includes(g.id));

        if (bannedGuilds.length > 0) {
            if (!data.blacklistedIPs.includes(ip)) {
                data.blacklistedIPs.push(ip);
                saveData(data);
            }
            const bannedNames = bannedGuilds.map(g => g.name).join(', ');

            await sendDiscordLog('🚨 블랙리스트 서버 소속 유저 차단', 16711680, [
                { name: '유저 이름', value: `${user.username} (${user.id})`, inline: true },
                { name: '차단된 IP', value: `\`${ip}\``, inline: true },
                { name: '소속된 차단 서버', value: bannedNames, inline: false }
            ]);

            return res.status(403).send(`
                <div style="text-align:center; padding: 50px; font-family: sans-serif;">
                    <h1 style="color: red;">[접속 거부]</h1>
                    <p>차단된 서버(<b>${bannedNames}</b>)에 소속되어 접근이 거부되었습니다.</p>
                    <p>귀하의 IP가 차단 목록에 등록되었습니다.</p>
                </div>
            `);
        }

        const apiKey = process.env.IPWHO_API_KEY || '';
        const ipwhoRes = await axios.get(`http://ipwho.is/${ip}${apiKey ? `?key=${apiKey}` : ''}`);
        const ipData = ipwhoRes.data;

        if (ipData.success && ipData.security) {
            if (ipData.security.vpn || ipData.security.proxy || ipData.security.tor) {
                await sendDiscordLog('⚠️ VPN 접속 감지 차단', 16753920, [
                    { name: '유저 이름', value: `${user.username} (${user.id})`, inline: true },
                    { name: '시도 IP', value: `\`${ip}\``, inline: true },
                    { name: '위치', value: `${ipData.country} / ${ipData.city}`, inline: false }
                ]);

                return res.status(403).send(`
                    <div style="text-align:center; padding: 50px; font-family: sans-serif;">
                        <h1 style="color: red;">[VPN 차단]</h1>
                        <p>VPN 또는 프록시 우회 접속이 감지되었습니다.</p>
                        <p>정상적인 네트워크로 변경 후 다시 시도해주세요.</p>
                    </div>
                `);
            }
        }

        await sendDiscordLog('✅ 유저 인증 완료', 65280, [
            { name: '유저 이름', value: `${user.username} (${user.id})`, inline: true },
            { name: '접속 IP', value: `\`${ip}\``, inline: true }
        ]);

        req.session.user = { id: user.id, username: user.username, ip: ip };
        res.redirect('/');

    } catch (err) {
        console.error('OAuth 인증 에러:', err.response?.data || err.message);
        res.status(500).send('인증 처리 중 서버 오류가 발생했습니다.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 통합 서버(웹사이트 + 봇) 실행 중 (포트 ${PORT})`));

