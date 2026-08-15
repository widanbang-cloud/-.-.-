require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==========================================
// 🗂️ 데이터베이스 세팅 (서버별 보안 데이터)
// ==========================================
let botData = { 
    serverLogs: {}, 
    ownerDMs: [], 
    serverBlacklists: {},
    ipRecords: {}, 
    altLimits: {}  
};
if (fs.existsSync(DATA_FILE)) botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ==========================================
// 🤖 봇 슬래시 명령어 (보안/관리 전용)
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('서버지정').setDescription('이 채널을 인증 로그 채널로 지정합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버지정취소').setDescription('인증 로그 채널 지정을 해제합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정').setDescription('인증 로그를 서버장 DM으로 수신합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정취소').setDescription('서버장 DM 수신을 해제합니다. (관리자용)'),
    new SlashCommandBuilder().setName('블랙리스트추가').setDescription('특정 유저의 웹 인증을 원천 차단합니다.')
        .addUserOption(option => option.setName('유저').setDescription('차단할 유저').setRequired(true)),
    new SlashCommandBuilder().setName('블랙리스트목록').setDescription('차단된 유저 목록을 확인합니다.'),
    new SlashCommandBuilder().setName('블랙리스트삭제').setDescription('유저 차단을 해제합니다.')
        .addUserOption(option => option.setName('유저').setDescription('차단 해제할 유저').setRequired(true)),
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

    // ⛔ 철통 보안: 서버 관리자 권한 필수
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
    } else if (commandName === '블랙리스트추가') {
        const user = interaction.options.getUser('유저');
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(user.id)) botData.serverBlacklists[guildId].push(user.id);
        saveData();
        await interaction.reply({ content: `🚨 **${user.tag}** 님이 이 서버의 인증 시스템에서 영구 차단되었습니다.`, ephemeral: true });
    } else if (commandName === '블랙리스트목록') {
        const list = botData.serverBlacklists[guildId] || [];
        await interaction.reply({ content: `📜 **서버 차단 목록:**\n${list.length > 0 ? list.join('\n') : '차단된 유저가 없습니다.'}`, ephemeral: true });
    } else if (commandName === '블랙리스트삭제') {
        const user = interaction.options.getUser('유저');
        if (botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = botData.serverBlacklists[guildId].filter(id => id !== user.id);
        saveData();
        await interaction.reply({ content: `✅ **${user.tag}** 님의 차단이 풀렸습니다.`, ephemeral: true });
    } else if (commandName === '부계확인') {
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
app.set('trust proxy', true); // 프록시(Render) 뒤에서 진짜 IP 가져오기 필수

// 🌐 1. 기본 접속 페이지 (내 IP 확인용)
app.get('/', (req, res) => {
    const visitorIP = req.ip || req.connection.remoteAddress;
    res.send(`
        <div style="text-align:center; margin-top:80px; font-family:sans-serif;">
            <h1 style="color:#5865F2;">🛡️ 인증 시스템 가동 중</h1>
            <p>비정상적인 접근은 모두 서버에 기록됩니다.</p>
            <hr style="width:350px; margin:20px auto;">
            <p style="color:gray; font-size:16px;">당신의 현재 접속 IP: <strong>${visitorIP}</strong></p>
        </div>
    `);
});

// 🔐 2. 디스코드 콜백 통로 (인증 완료 처리)
app.get('/auth/discord/callback', async (req, res) => {
    const { code, state: guildId } = req.query; 
    if (!code || !guildId) return res.send('<h2 style="color:red;text-align:center;margin-top:50px;">❌ 비정상적인 접근입니다. 디스코드 봇을 통해 접속하세요.</h2>');

    try {
        // [토큰 획득]
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code', code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        // [유저 정보 획득]
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        const userData = userRes.data;
        const userIP = req.ip || req.connection.remoteAddress;

        // ⛔ 1. 관리자 블랙리스트 컷
        if (botData.serverBlacklists[guildId]?.includes(userData.id)) {
            return res.send('<h1 style="color:red;text-align:center;margin-top:50px;">🚫 서버 관리자에 의해 인증이 차단된 계정입니다.</h1>');
        }

        if (!botData.ipRecords[guildId]) botData.ipRecords[guildId] = {};
        if (!botData.ipRecords[guildId][userIP]) botData.ipRecords[guildId][userIP] = [];
        const ipUsers = botData.ipRecords[guildId][userIP];

        // ⛔ 2. 부계정 다중 접속 컷
        const limit = botData.altLimits[guildId];
        if (limit && limit > 0 && !ipUsers.includes(userData.id) && ipUsers.length >= limit) {
            return res.send(`
                <h1 style="color:red; text-align:center; margin-top:50px;">🚫 부계정 방어벽 작동</h1>
                <p style="text-align:center;">동일 네트워크(IP)에서 허용된 계정 수(${limit}개)를 초과했습니다.</p>
            `);
        }

        // 통과 완료! (기록 저장)
        if (!ipUsers.includes(userData.id)) {
            ipUsers.push(userData.id);
            saveData();
        }

        // 📡 3. IP 정보 조회 (API 키가 들어갔으니 이제 상세 정보 뜸!)
        let ipInfoText = '기본 IP만 수집됨';
        if (process.env.IPWHO_API_KEY) {
            try {
                const ipwho = await axios.get(`https://ipwho.is/${userIP}?key=${process.env.IPWHO_API_KEY}`);
                if (ipwho.data.success) {
                    ipInfoText = `🌍 **${ipwho.data.country}** (${ipwho.data.city})\n🏢 ISP: ${ipwho.data.connection.isp}`;
                }
            } catch (e) {
                console.error("IP API 에러 발생");
            }
        }

        // 📝 4. 디스코드 예쁜 로그 Embed 생성
        const isAlt = ipUsers.length > 1;
        const logEmbed = new EmbedBuilder()
            .setColor(isAlt ? 0xFF0000 : 0x00FF00) // 부계면 빨간색, 정상이면 초록색
            .setTitle('🔐 디스코드 웹 인증 완료')
            .setThumbnail(`https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`)
            .addFields(
                { name: '👤 유저 정보', value: `<@${userData.id}> (${userData.username})`, inline: true },
                { name: '🌐 접속 IP', value: userIP, inline: true },
                { name: '📍 위치 및 통신사', value: ipInfoText, inline: false },
            )
            .setFooter({ text: isAlt ? `⚠️ 다중 계정 경고: 이 IP에서 ${ipUsers.length}개의 계정이 발견됨` : '✅ 정상적인 인증 접근' })
            .setTimestamp();

        // 로그 발사
        await sendLog(guildId, { embeds: [logEmbed] });

        // 성공 화면 렌더링
        res.send(`
            <div style="text-align:center; margin-top:80px; font-family:sans-serif;">
                <h1 style="color:green;">✅ 인증이 정상적으로 완료되었습니다!</h1>
                <p>디스코드 서버로 돌아가서 봇의 안내를 확인하세요.</p>
                <button onclick="window.close()" style="padding:10px 20px; margin-top:20px; font-size:16px; cursor:pointer;">창 닫기</button>
            </div>
        `);
    } catch (error) {
        console.error(error);
        res.send('<h2 style="color:red;text-align:center;">❌ 서버와 통신 중 오류가 발생했습니다.</h2>');
    }
});

// 🚀 지정된 곳으로 로그 보내는 함수
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
