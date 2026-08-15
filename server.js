require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==========================================
// 🗂️ 데이터베이스 세팅
// ==========================================
let botData = { 
    serverLogs: {}, 
    ownerDMs: [], 
    serverBlacklists: {},
    ipRecords: {}, // 서버별 IP 기록 { guildId: { "192.168...": ["유저ID1", "유저ID2"] } }
    altLimits: {}  // 서버별 부계정 허용 한도 { guildId: 허용개수 }
};
if (fs.existsSync(DATA_FILE)) botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ==========================================
// 🤖 봇 슬래시 명령어 세팅
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('서버지정').setDescription('이 채널을 인증 로그 채널로 지정 (관리자용)'),
    new SlashCommandBuilder().setName('서버지정취소').setDescription('인증 로그 채널 해제 (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정').setDescription('인증 로그를 서버장 DM으로 수신 (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정취소').setDescription('서버장 DM 수신 해제 (관리자용)'),
    new SlashCommandBuilder().setName('블랙리스트추가').setDescription('특정 유저를 인증 차단')
        .addUserOption(option => option.setName('유저').setDescription('차단할 유저').setRequired(true)),
    new SlashCommandBuilder().setName('블랙리스트목록').setDescription('차단된 유저 목록 확인'),
    new SlashCommandBuilder().setName('블랙리스트삭제').setDescription('유저 차단 해제')
        .addUserOption(option => option.setName('유저').setDescription('차단 해제할 유저').setRequired(true)),
    new SlashCommandBuilder().setName('부계확인').setDescription('동일한 IP로 인증한 부계정 의심 목록을 확인합니다.'),
    new SlashCommandBuilder().setName('부계차단설정').setDescription('동일 IP 허용 최대 계정 수를 설정합니다.')
        .addIntegerOption(option => option.setName('개수').setDescription('허용할 개수 (0 입력 시 무제한)').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('ready', async () => {
    console.log(`🤖 봇 로그인 완료: ${client.user.tag}`);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ 슬래시 명령어 등록 완료!');
});

// 명령어 처리 로직
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 서버 관리자(Manage Server) 권한이 필요합니다.', ephemeral: true });
    }

    const { commandName, guildId } = interaction;

    // (기존 명령어들은 생략 없이 동일하게 작동)
    if (commandName === '서버지정') {
        botData.serverLogs[guildId] = interaction.channelId;
        saveData();
        await interaction.reply({ content: '✅ 인증 로그 채널로 지정되었습니다.', ephemeral: true });
    } else if (commandName === '서버지정취소') {
        delete botData.serverLogs[guildId];
        saveData();
        await interaction.reply({ content: '✅ 인증 로그 채널이 취소되었습니다.', ephemeral: true });
    } else if (commandName === '서버장지정') {
        if (!botData.ownerDMs.includes(guildId)) botData.ownerDMs.push(guildId);
        saveData();
        await interaction.reply({ content: '✅ 인증 로그를 서버장 DM으로 전송합니다.', ephemeral: true });
    } else if (commandName === '서버장지정취소') {
        botData.ownerDMs = botData.ownerDMs.filter(id => id !== guildId);
        saveData();
        await interaction.reply({ content: '✅ 서버장 DM 전송이 취소되었습니다.', ephemeral: true });
    } else if (commandName === '블랙리스트추가') {
        const user = interaction.options.getUser('유저');
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(user.id)) botData.serverBlacklists[guildId].push(user.id);
        saveData();
        await interaction.reply({ content: `✅ **${user.tag}** 님이 차단되었습니다.`, ephemeral: true });
    } else if (commandName === '블랙리스트목록') {
        const list = botData.serverBlacklists[guildId] || [];
        await interaction.reply({ content: `📜 **차단 목록:**\n${list.length > 0 ? list.join('\n') : '없음'}`, ephemeral: true });
    } else if (commandName === '블랙리스트삭제') {
        const user = interaction.options.getUser('유저');
        if (botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = botData.serverBlacklists[guildId].filter(id => id !== user.id);
        saveData();
        await interaction.reply({ content: `✅ **${user.tag}** 님의 차단이 해제되었습니다.`, ephemeral: true });
    } 
    // 👥 부계정 관련 기능 추가
    else if (commandName === '부계확인') {
        const serverIps = botData.ipRecords[guildId] || {};
        let result = [];
        for (const [ip, users] of Object.entries(serverIps)) {
            if (users.length > 1) {
                result.push(`**IP [ ${ip} ]**\n └ 계정 목록: ${users.map(id => `<@${id}>`).join(', ')}`);
            }
        }
        if (result.length === 0) return interaction.reply({ content: '✅ 동일한 IP로 여러 번 인증된 부계정 의심 기록이 없습니다.', ephemeral: true });
        
        // 디스코드 메시지는 2000자 제한이 있으므로 너무 길면 잘라줌
        let replyMsg = `🚨 **부계정 의심 목록** 🚨\n\n${result.join('\n\n')}`;
        if (replyMsg.length > 2000) replyMsg = replyMsg.slice(0, 1995) + '...';
        await interaction.reply({ content: replyMsg, ephemeral: true });
    } 
    else if (commandName === '부계차단설정') {
        const limit = interaction.options.getInteger('개수');
        if (limit === 0) {
            delete botData.altLimits[guildId];
            saveData();
            await interaction.reply({ content: '✅ 동일 IP 다중 인증 제한을 **해제(무제한)** 했습니다.', ephemeral: true });
        } else {
            botData.altLimits[guildId] = limit;
            saveData();
            await interaction.reply({ content: `✅ 앞으로 동일한 IP에서는 **최대 ${limit}개**의 계정만 인증할 수 있습니다.`, ephemeral: true });
        }
    }
});

// ==========================================
// 🌍 웹 서버 세팅 (IP 수집, 부계정 체크, OAuth2 연동)
// ==========================================
app.set('trust proxy', true);

app.get('/auth/discord/callback', async (req, res) => {
    const { code, state: guildId } = req.query; 
    if (!code || !guildId) return res.send('❌ 잘못된 접근입니다.');

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

        // ⛔ 블랙리스트 확인
        if (botData.serverBlacklists[guildId]?.includes(userData.id)) {
            return res.send('<h1 style="color:red;text-align:center;">🚫 접근 차단됨 (관리자 차단)</h1>');
        }

        const userIP = req.ip || req.connection.remoteAddress;

        // 👥 1. IP 기록 저장
        if (!botData.ipRecords[guildId]) botData.ipRecords[guildId] = {};
        if (!botData.ipRecords[guildId][userIP]) botData.ipRecords[guildId][userIP] = [];
        const ipUsers = botData.ipRecords[guildId][userIP];

        // 👥 2. 부계정 제한 체크
        const limit = botData.altLimits[guildId];
        // 제한이 설정되어 있고(>0), 현재 유저가 새 유저이며, 이미 제한 개수를 채웠다면 차단
        if (limit && limit > 0 && !ipUsers.includes(userData.id) && ipUsers.length >= limit) {
            return res.send(`
                <h1 style="color:red; text-align:center; margin-top:50px;">🚫 부계정 생성 제한</h1>
                <p style="text-align:center;">이 IP에서는 최대 ${limit}개의 계정만 인증할 수 있습니다.</p>
            `);
        }

        // 통과 시, IP 기록에 유저 ID 추가
        if (!ipUsers.includes(userData.id)) {
            ipUsers.push(userData.id);
            saveData();
        }

        let ipInfoText = 'IP 정보 조회 실패';
        if (process.env.IPWHO_API_KEY) {
            try {
                const ipwho = await axios.get(`https://ipwho.is/${userIP}?key=${process.env.IPWHO_API_KEY}`);
                if (ipwho.data.success) ipInfoText = `${ipwho.data.country}, ${ipwho.data.city} (${ipwho.data.connection.isp})`;
            } catch (e) {}
        }

        // 📝 3. 인증 로그에 부계정 의심 여부 표시 추가
        const isAlt = ipUsers.length > 1;
        const logEmbed = new EmbedBuilder()
            .setColor(isAlt ? 0xFFA500 : 0x00FF00) // 부계정이면 주황색, 아니면 초록색
            .setTitle('✅ 새로운 유저 인증 완료')
            .setThumbnail(`https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`)
            .addFields(
                { name: '사용자', value: `<@${userData.id}> (${userData.username})`, inline: true },
                { name: '접속 IP', value: userIP, inline: true },
                { name: 'IP 세부 정보', value: ipInfoText, inline: false },
                { name: '⚠️ 다중 계정(부계) 의심', value: isAlt ? `**주의!** 이 IP로 총 **${ipUsers.length}개**의 계정이 인증됨` : '없음 (정상)', inline: false }
            ).setTimestamp();

        await sendLog(guildId, { embeds: [logEmbed] });

        res.send('<h1 style="color:green;text-align:center;margin-top:50px;">✅ 인증 성공! 디스코드로 돌아가세요.</h1>');
    } catch (error) {
        res.send('❌ 인증 중 오류가 발생했습니다.');
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
            if (owner) await owner.send({ content: `**[${guild.name}]** 인증 알림`, embeds: payload.embeds });
        }
    } catch (e) {}
}

client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🌍 포트 ${PORT} 가동 중!`));
