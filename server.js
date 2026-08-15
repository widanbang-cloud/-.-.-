require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==========================================
// 🗂️ 데이터베이스 세팅 (서버별 보안 데이터)
// ==========================================
let botData = { 
    serverLogs: {}, 
    ownerDMs: [], 
    serverBlacklists: {},     // 유저 차단 목록
    serverIpBlacklists: {},   // IP 차단 목록
    ipRecords: {}, 
    altLimits: {},
    verifyRoles: {}           // 인증 시 지급할 역할 저장
};
if (fs.existsSync(DATA_FILE)) botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));

// 💡 봇 인텐트에 GuildMembers가 반드시 포함되어 있어야 역할 지급이 원활합니다.
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers 
    ] 
});

// ==========================================
// 🤖 봇 슬래시 명령어 세팅
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('서버지정').setDescription('이 채널을 인증 로그 채널로 지정합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버지정취소').setDescription('인증 로그 채널 지정을 해제합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정').setDescription('인증 로그를 서버장 DM으로 수신합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정취소').setDescription('서버장 DM 수신을 해제합니다. (관리자용)'),
    
    // 🛡️ 인증 패널 설치 명령어 (역할 선택 포함)
    new SlashCommandBuilder().setName('인증패널설치').setDescription('인증 버튼이 포함된 패널을 설치합니다. (관리자용)')
        .addRoleOption(option => option.setName('역할').setDescription('인증 성공 시 지급할 역할(팀)').setRequired(true))
        .addChannelOption(option => option.setName('채널').setDescription('패널을 설치할 채널 (미입력 시 현재 채널)').setRequired(false)),
    
    // 🛑 차단 관련 명령어
    new SlashCommandBuilder().setName('서버차단').setDescription('특정 유저의 웹 인증을 차단합니다.')
        .addUserOption(option => option.setName('유저').setDescription('차단할 유저').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단해제').setDescription('특정 유저의 웹 인증 차단을 해제합니다.')
        .addUserOption(option => option.setName('유저').setDescription('차단 해제할 유저').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단목록').setDescription('서버에서 차단된 유저 목록을 확인합니다.'),
    
    new SlashCommandBuilder().setName('ip차단').setDescription('특정 IP 주소의 웹 인증을 차단합니다.')
        .addStringOption(option => option.setName('아이피').setDescription('차단할 IP 주소 (예: 123.45.67.89)').setRequired(true)),
    new SlashCommandBuilder().setName('ip차단해제').setDescription('특정 IP 주소의 차단을 해제합니다.')
        .addStringOption(option => option.setName('아이피').setDescription('해제할 IP 주소').setRequired(true)),

    new SlashCommandBuilder().setName('부계확인').setDescription('동일한 IP로 인증한 부계정 의심 목록을 확인합니다.'),
    new SlashCommandBuilder().setName('부계차단설정').setDescription('동일 IP 허용 최대 계정 수를 설정합니다.')
        .addIntegerOption(option => option.setName('개수').setDescription('허용할 개수 (0 입력 시 무제한)').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('ready', async () => {
    console.log(`🤖 보안 봇 로그인 완료: ${client.user.tag}`);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ 슬래시 명령어 세팅 완료!');
});

// ==========================================
// 💬 명령어 처리 로직
// ==========================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // ⛔ 관리자 권한 체크
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 접근 거부: 서버 관리자(Manage Server) 권한이 필요합니다.', ephemeral: true });
    }

    const { commandName, guildId } = interaction;

    if (commandName === '서버지정') {
        botData.serverLogs[guildId] = interaction.channelId;
        saveData();
        await interaction.reply({ content: '✅ 이 채널로 인증 로그가 전송됩니다.', ephemeral: true });
    } else if (commandName === '서버지정취소') {
        delete botData.serverLogs[guildId];
        saveData();
        await interaction.reply({ content: '✅ 인증 로그 채널 전송이 해제되었습니다.', ephemeral: true });
    } else if (commandName === '서버장지정') {
        if (!botData.ownerDMs.includes(guildId)) botData.ownerDMs.push(guildId);
        saveData();
        await interaction.reply({ content: '✅ 앞으로 인증 로그를 서버장님 DM으로 쏴드립니다.', ephemeral: true });
    } else if (commandName === '서버장지정취소') {
        botData.ownerDMs = botData.ownerDMs.filter(id => id !== guildId);
        saveData();
        await interaction.reply({ content: '✅ 서버장 DM 수신이 취소되었습니다.', ephemeral: true });
    } 
    
    // 🔐 인증 패널 설치 로직
    else if (commandName === '인증패널설치') {
        const role = interaction.options.getRole('역할');
        const channel = interaction.options.getChannel('채널') || interaction.channel;

        botData.verifyRoles[guildId] = role.id;
        saveData();

        // OAuth2 인증 링크 생성 (scope에 identify와 guilds 포함)
        const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify+guilds&state=${guildId}`;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛡️ 디스코드 보안 인증 시스템')
            .setDescription(`서버 이용을 위해 **[인증하기]** 버튼을 눌러 보안 인증 및 IP 확인을 진행해 주세요.\n\n> 인증 완료 시 자동으로 **${role.name}** 역할이 지급됩니다.`)
            .setFooter({ text: '안전한 서버 환경을 위한 필수 절차입니다.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🔐 인증하기 (IP 확인 및 동의)')
                .setStyle(ButtonStyle.Link)
                .setURL(oauthUrl)
        );

        await channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: `✅ 성공적으로 **${channel.name}** 채널에 인증 패널을 설치했습니다! (지급 역할: ${role.name})`, ephemeral: true });
    }

    // 🛑 서버 차단 관련 로직
    else if (commandName === '서버차단') {
        const user = interaction.options.getUser('유저');
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(user.id)) botData.serverBlacklists[guildId].push(user.id);
        saveData();
        await interaction.reply({ content: `🚨 **${user.tag}** 님이 이 서버의 인증 시스템에서 영구 차단되었습니다.`, ephemeral: true });
    } else if (commandName === '서버차단해제') {
        const user = interaction.options.getUser('유저');
        if (botData.serverBlacklists[guildId]) {
            botData.serverBlacklists[guildId] = botData.serverBlacklists[guildId].filter(id => id !== user.id);
        }
        saveData();
        await interaction.reply({ content: `✅ **${user.tag}** 님의 서버 차단이 해제되었습니다.`, ephemeral: true });
    } else if (commandName === '서버차단목록') {
        const list = botData.serverBlacklists[guildId] || [];
        const mentions = list.map(id => `<@${id}>`).join('\n') || '차단된 유저가 없습니다.';
        await interaction.reply({ content: `📜 **서버 차단된 유저 목록:**\n${mentions}`, ephemeral: true });
    } 
    
    // 🌐 IP 차단 관련 로직
    else if (commandName === 'ip차단') {
        const ip = interaction.options.getString('아이피').trim();
        if (!botData.serverIpBlacklists[guildId]) botData.serverIpBlacklists[guildId] = [];
        if (!botData.serverIpBlacklists[guildId].includes(ip)) botData.serverIpBlacklists[guildId].push(ip);
        saveData();
        await interaction.reply({ content: `🛑 IP 주소 **[ ${ip} ]** 가 이 서버의 인증 시스템에서 차단되었습니다.`, ephemeral: true });
    } else if (commandName === 'ip차단해제') {
        const ip = interaction.options.getString('아이피').trim();
        if (botData.serverIpBlacklists[guildId]) {
            botData.serverIpBlacklists[guildId] = botData.serverIpBlacklists[guildId].filter(item => item !== ip);
        }
        saveData();
        await interaction.reply({ content: `✅ IP 주소 **[ ${ip} ]** 의 차단이 해제되었습니다.`, ephemeral: true });
    } 
    
    // 부계정 관련 로직
    else if (commandName === '부계확인') {
        const serverIps = botData.ipRecords[guildId] || {};
        let result = [];
        for (const [ip, users] of Object.entries(serverIps)) {
            if (users.length > 1) {
                result.push(`**IP [ ${ip} ]**\n └ 계정: ${users.map(id => `<@${id}>`).join(', ')}`);
            }
        }
        if (result.length === 0) return interaction.reply({ content: '✅ 다중 계정(부계)으로 의심되는 IP 접근 기록이 없습니다.', ephemeral: true });
        
        let replyMsg = `🚨 **다중 계정 접속 의심 로그** 🚨\n\n${result.join('\n\n')}`;
        if (replyMsg.length > 2000) replyMsg = replyMsg.slice(0, 1995) + '...';
        await interaction.reply({ content: replyMsg, ephemeral: true });
    } else if (commandName === '부계차단설정') {
        const limit = interaction.options.getInteger('개수');
        if (limit === 0) {
            delete botData.altLimits[guildId];
            saveData();
            await interaction.reply({ content: '✅ 부계정 인증 제한을 **무제한**으로 변경했습니다.', ephemeral: true });
        } else {
            botData.altLimits[guildId] = limit;
            saveData();
            await interaction.reply({ content: `🛡️ 방어벽 가동: 이제 동일 IP에서는 **최대 ${limit}개**의 계정만 인증 가능합니다.`, ephemeral: true });
        }
    }
});

// ==========================================
// 🌍 웹 서버 세팅 (IP 조회 및 OAuth2 통신)
// ==========================================
app.set('trust proxy', true);

// 🛠️ 프록시 및 로컬 환경에서 정확한 클라이언트 IP를 가져오는 헬퍼 함수
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

// 🌐 1. 기본 접속 페이지 (내 IP 확인용)
app.get('/', (req, res) => {
    const visitorIP = getClientIp(req);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>보안 인증 시스템</title>
            <style>
                body { background-color: #121214; color: #e1e1e6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: #202024; padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); text-align: center; width: 400px; border: 1px solid #323238; }
                h1 { color: #5865F2; margin-bottom: 10px; font-size: 22px; }
                p { color: #8d8d99; font-size: 14px; }
                .ip-box { background: #121214; padding: 12px; border-radius: 8px; margin-top: 20px; font-size: 16px; color: #00b37e; border: 1px solid #29292e; font-weight: bold; }
                hr { border: 0; border-top: 1px solid #323238; margin: 25px 0; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🛡️ 보안 인증 시스템 가동 중</h1>
                <p>비정상적인 접근은 모두 서버에 기록됩니다.</p>
                <hr>
                <p>당신의 현재 접속 IP</p>
                <div class="ip-box">${visitorIP}</div>
            </div>
        </body>
        </html>
    `);
});

// 🔐 2. 디스코드 콜백 통로 (인증 완료, IP 확인, 역할 지급, VPN 체크)
app.get('/auth/discord/callback', async (req, res) => {
    const { code, state: guildId } = req.query; 
    if (!code || !guildId) return res.send('<h2 style="color:red;text-align:center;margin-top:50px;">❌ 비정상적인 접근입니다. 디스코드 봇을 통해 접속하세요.</h2>');

    const userIP = getClientIp(req);

    // 📍 1. IP 세부 정보 및 VPN 조회 (ipwho.is 활용)
    let ipInfoText = '기본 IP만 수집됨';
    let isVpnOrProxy = false;

    if (process.env.IPWHO_API_KEY) {
        try {
            const ipwho = await axios.get(`https://ipwho.is/${userIP}?key=${process.env.IPWHO_API_KEY}`);
            if (ipwho.data.success) {
                ipInfoText = `🌍 **${ipwho.data.country}** (${ipwho.data.city}) / ISP: ${ipwho.data.connection.isp}`;
                
                // ipwho.is 보안 데이터(VPN, 프록시, 토르 등 판별) 검사
                const security = ipwho.data.security;
                if (security && (security.vpn || security.proxy || security.tor || security.hosting)) {
                    isVpnOrProxy = true;
                }
            }
        } catch (e) {
            console.error("IPWHO API 에러:", e.message);
        }
    }

    // 🛑 2. VPN / 프록시 접속 차단
    if (isVpnOrProxy) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>VPN/프록시 차단</title>
                <style>
                    body { background-color: #121214; color: #e1e1e6; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .card { background: #202024; padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); text-align: center; width: 420px; border: 1px solid #323238; }
                    h1 { color: #f75a68; font-size: 20px; }
                    p { color: #c4c4cc; font-size: 14px; line-height: 1.5; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>🚫 VPN 및 프록시 우회 감지</h1>
                    <p>현재 VPN, 프록시, 혹은 호스팅 네트워크(IP: <strong>${userIP}</strong>)를 사용 중이므로 보안 정책에 따라 인증이 거부되었습니다. VPN을 끄고 다시 시도해 주세요.</p>
                </div>
            </body>
            </html>
        `);
    }

    // 🛑 3. 수동 IP 차단 여부 검사
    if (botData.serverIpBlacklists[guildId]?.includes(userIP)) {
        return res.send(`
            <h1 style="color:red; text-align:center; margin-top:50px;">🚫 IP 접근 차단됨</h1>
            <p style="text-align:center;">현재 접속하신 네트워크(IP: ${userIP})는 서버 관리자에 의해 인증이 차단되었습니다.</p>
        `);
    }

    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code', code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        const userData = userRes.data;

        // ⛔ 4. 유저(ID) 서버 차단 여부 검사
        if (botData.serverBlacklists[guildId]?.includes(userData.id)) {
            return res.send('<h1 style="color:red;text-align:center;margin-top:50px;">🚫 서버 관리자에 의해 인증이 차단된 계정입니다.</h1>');
        }

        if (!botData.ipRecords[guildId]) botData.ipRecords[guildId] = {};
        if (!botData.ipRecords[guildId][userIP]) botData.ipRecords[guildId][userIP] = [];
        const ipUsers = botData.ipRecords[guildId][userIP];

        // ⛔ 5. 부계정 다중 접속 컷
        const limit = botData.altLimits[guildId];
        if (limit && limit > 0 && !ipUsers.includes(userData.id) && ipUsers.length >= limit) {
            return res.send(`
                <h1 style="color:red; text-align:center; margin-top:50px;">🚫 부계정 방어벽 작동</h1>
                <p style="text-align:center;">동일 네트워크(IP)에서 허용된 계정 수(${limit}개)를 초과했습니다.</p>
            `);
        }

        if (!ipUsers.includes(userData.id)) {
            ipUsers.push(userData.id);
            saveData();
        }

        // 🎖️ 6. 인증 성공 시 지정된 역할(팀) 자동 지급 (오류 방지 및 안정화 보완)
        const roleId = botData.verifyRoles[guildId];
        if (roleId) {
            try {
                const guild = await client.guilds.fetch(guildId);
                if (guild) {
                    // 캐시에 없거나 최신 상태를 유지하기 위해 fetch 사용
                    const member = await guild.members.fetch(userData.id).catch(() => null);
                    if (member) {
                        await member.roles.add(roleId);
                        console.log(`[역할 지급 성공] ${guild.name} 서버의 ${member.user.tag} 님에게 역할 지급 완료`);
                    } else {
                        console.log(`[역할 지급 실패] 유저가 서버에 존재하지 않거나 봇이 찾지 못했습니다.`);
                    }
                }
            } catch (roleErr) {
                console.error("역할 지급 실패 (봇의 역할 위치가 지급하려는 역할보다 낮거나 권한이 부족합니다):", roleErr);
            }
        }

        const isAlt = ipUsers.length > 1;
        const logEmbed = new EmbedBuilder()
            .setColor(isAlt ? 0xFF0000 : 0x00FF00)
            .setTitle('🔐 디스코드 웹 인증 완료 및 역할 지급')
            .setThumbnail(`https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`)
            .addFields(
                { name: '👤 유저 정보', value: `<@${userData.id}> (${userData.username})`, inline: true },
                { name: '🌐 접속 IP', value: userIP, inline: true },
                { name: '📍 위치 및 통신사', value: ipInfoText, inline: false },
            )
            .setFooter({ text: isAlt ? `⚠️ 다중 계정 경고: 이 IP에서 ${ipUsers.length}개의 계정이 발견됨` : '✅ 정상적인 인증 접근' })
            .setTimestamp();

        await sendLog(guildId, { embeds: [logEmbed] });

        // 프로필 아바타 및 배너 URL 생성
        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=128` 
            : `https://cdn.discordapp.com/embed/avatars/0.png`;
        
        const bannerUrl = userData.banner 
            ? `https://cdn.discordapp.com/banners/${userData.id}/${userData.banner}.png?size=600` 
            : null;

        // 🌟 7. 세련되고 예쁜 다크모드 디자인의 웹 응답 페이지
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>인증 완료</title>
                <style>
                    body { background-color: #121214; color: #e1e1e6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .card { background: #202024; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); text-align: center; width: 440px; border: 1px solid #323238; overflow: hidden; }
                    .banner { width: 100%; height: 110px; background-color: #5865F2; background-size: cover; background-position: center; }
                    .avatar { width: 84px; height: 84px; border-radius: 50%; border: 4px solid #202024; margin-top: -45px; background: #2f3136; position: relative; }
                    .content { padding: 0 30px 35px 30px; }
                    h2 { color: #f1f1f3; margin: 12px 0 2px 0; font-size: 20px; }
                    .tag { color: #8d8d99; font-size: 13px; margin-bottom: 20px; }
                    .badge { display: inline-block; background: rgba(0, 179, 126, 0.15); color: #00b37e; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 20px; border: 1px solid rgba(0, 179, 126, 0.3); }
                    .info-box { background: #121214; padding: 14px; border-radius: 8px; font-size: 14px; color: #c4c4cc; border: 1px solid #29292e; text-align: left; margin-bottom: 15px; }
                    .info-box strong { color: #fba94c; }
                    .btn { width: 100%; padding: 12px; font-size: 15px; font-weight: bold; background: #5865F2; color: white; border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s; }
                    .btn:hover { background: #4752c4; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="banner" ${bannerUrl ? `style="background-image: url('${bannerUrl}');"` : ''}></div>
                    <img src="${avatarUrl}" class="avatar">
                    <h2>${userData.global_name || userData.username}</h2>
                    <div class="tag">@${userData.username}</div>
                    
                    <div class="content">
                        <div class="badge">✅ 인증 및 역할 지급 완료</div>
                        <div class="info-box">
                            <div>현재 접속 IP: <strong>${userIP}</strong></div>
                            <div style="font-size: 12px; color: #8d8d99; margin-top: 6px;">${ipInfoText}</div>
                        </div>
                        <button class="btn" onclick="window.close()">창 닫기</button>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error(error);
        res.send('<h2 style="color:red;text-align:center;margin-top:50px;">❌ 서버와 통신 중 오류가 발생했습니다.</h2>');
    }
});

async function sendLog(guildId, payload) {
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) return;
        const channelId = botData.serverLogs[guildId];
        if (channelId) {
            const channel = guild.channels.cache.get(channelId);
            if (channel) await channel.send(payload);
        }
        if (botData.ownerDMs.includes(guildId)) {
            const owner = await guild.fetchOwner();
            if (owner) await owner.send({ content: `🚨 **[${guild.name}]** 보안 인증 로그`, embeds: payload.embeds });
        }
    } catch (e) {}
}

client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🌍 보안 시스템 포트 ${PORT} 가동 완료!`));

