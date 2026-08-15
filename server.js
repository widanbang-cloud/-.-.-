require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==========================================
// 🗂️ 데이터베이스 세팅 (서버별 채널 및 블랙리스트)
// ==========================================
let botData = { serverLogs: {}, ownerDMs: [], serverBlacklists: {} };
if (fs.existsSync(DATA_FILE)) {
    botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
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
        .addUserOption(option => option.setName('유저').setDescription('차단 해제할 유저').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('ready', async () => {
    console.log(`🤖 봇 로그인 완료: ${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) {
        console.error('명령어 등록 에러:', error);
    }
});

// 명령어 처리 로직
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // ⛔ 권한 체크: 서버 관리자 권한이 없으면 거부
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 서버 관리자(Manage Server) 권한이 필요합니다.', ephemeral: true });
    }

    const { commandName, guildId } = interaction;

    if (commandName === '서버지정') {
        botData.serverLogs[guildId] = interaction.channelId;
        saveData();
        await interaction.reply({ content: '✅ 이 채널이 인증 로그 채널로 지정되었습니다.', ephemeral: true });
    } else if (commandName === '서버지정취소') {
        delete botData.serverLogs[guildId];
        saveData();
        await interaction.reply({ content: '✅ 인증 로그 채널 지정이 취소되었습니다.', ephemeral: true });
    } else if (commandName === '서버장지정') {
        if (!botData.ownerDMs.includes(guildId)) botData.ownerDMs.push(guildId);
        saveData();
        await interaction.reply({ content: '✅ 앞으로 인증 로그를 서버장 DM으로 전송합니다.', ephemeral: true });
    } else if (commandName === '서버장지정취소') {
        botData.ownerDMs = botData.ownerDMs.filter(id => id !== guildId);
        saveData();
        await interaction.reply({ content: '✅ 서버장 DM 로그 전송이 취소되었습니다.', ephemeral: true });
    } else if (commandName === '블랙리스트추가') {
        const user = interaction.options.getUser('유저');
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(user.id)) {
            botData.serverBlacklists[guildId].push(user.id);
            saveData();
        }
        await interaction.reply({ content: `✅ **${user.tag}** 님이 해당 서버 인증에서 차단되었습니다.`, ephemeral: true });
    } else if (commandName === '블랙리스트목록') {
        const list = botData.serverBlacklists[guildId] || [];
        await interaction.reply({ content: `📜 **차단된 유저 목록 (ID):**\n${list.length > 0 ? list.join('\n') : '없음'}`, ephemeral: true });
    } else if (commandName === '블랙리스트삭제') {
        const user = interaction.options.getUser('유저');
        if (botData.serverBlacklists[guildId]) {
            botData.serverBlacklists[guildId] = botData.serverBlacklists[guildId].filter(id => id !== user.id);
            saveData();
        }
        await interaction.reply({ content: `✅ **${user.tag}** 님의 차단이 해제되었습니다.`, ephemeral: true });
    }
});

// ==========================================
// 🌍 웹 서버 세팅 (IP 수집, 동의서, OAuth2 연동)
// ==========================================

// 신뢰할 수 있는 프록시 설정 (Render 환경에서 올바른 IP를 가져오기 위해 필수)
app.set('trust proxy', true);

// 1. 디스코드 인증 완료 후 돌아오는 콜백 주소
app.get('/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query; // state에는 서버 ID(guildId)가 들어있어야 합니다.
    const guildId = state;

    if (!code) return res.send('❌ 인증 코드가 없습니다.');
    if (!guildId) return res.send('❌ 서버 정보가 누락되었습니다. 봇이 제공한 링크로 다시 접속해 주세요.');

    try {
        // 🔑 1단계: 코드를 사용해 디스코드 엑세스 토큰 받아오기
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;

        // 👤 2단계: 토큰으로 유저 정보 받아오기
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        const userData = userResponse.data;

        // ⛔ 3단계: 블랙리스트 확인
        if (botData.serverBlacklists[guildId] && botData.serverBlacklists[guildId].includes(userData.id)) {
            return res.send(`
                <h1 style="color:red; text-align:center; margin-top:50px;">🚫 접근 차단됨</h1>
                <p style="text-align:center;">해당 서버 관리자에 의해 인증 시스템 이용이 차단되었습니다.</p>
            `);
        }

        // 🌐 4단계: 접속자 IP 추출 및 IPWHO API 조회
        const userIP = req.ip || req.connection.remoteAddress;
        let ipInfoText = 'IP 정보 조회 실패';

        if (process.env.IPWHO_API_KEY) {
            try {
                // IPWHO API 키를 쿼리에 담아서 전송
                const ipwhoRes = await axios.get(`https://ipwho.is/${userIP}?key=${process.env.IPWHO_API_KEY}`);
                if (ipwhoRes.data.success) {
                    ipInfoText = `국가: ${ipwhoRes.data.country}\n도시: ${ipwhoRes.data.city}\n통신사: ${ipwhoRes.data.connection.isp}`;
                }
            } catch (err) {
                console.error('IP 정보 조회 에러:', err.message);
            }
        }

        // 📝 5단계: 관리자에게 보낼 멋진 Embed 로그 생성
        const logEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ 새로운 유저 인증 완료')
            .setThumbnail(`https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`)
            .addFields(
                { name: '사용자 이름', value: `${userData.username}#${userData.discriminator} (<@${userData.id}>)`, inline: true },
                { name: '사용자 ID', value: userData.id, inline: true },
                { name: '접속 IP', value: userIP, inline: false },
                { name: 'IP 세부 정보', value: ipInfoText, inline: false }
            )
            .setTimestamp();

        // 📡 6단계: 설정된 채널 및 서버장에게 로그 전송
        await sendLog(guildId, { embeds: [logEmbed] });

        // 7단계: 유저에게 보여줄 성공 화면 (동의서 확인 완료 문구 포함)
        res.send(`
            <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
                <h1 style="color:green;">✅ 인증 성공!</h1>
                <p>디스코드 정보 제공 및 IP 수집 처리가 완료되었습니다.</p>
                <p>창을 닫고 디스코드 서버로 돌아가셔도 좋습니다.</p>
            </div>
        `);

    } catch (error) {
        console.error('인증 과정 중 에러 발생:', error.response ? error.response.data : error.message);
        res.send('❌ 인증 중 오류가 발생했습니다. 나중에 다시 시도해 주세요.');
    }
});

// 📡 로그 전송 함수 (지정된 채널 + 서버장 DM)
async function sendLog(guildId, messagePayload) {
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) return;

        // 1. 지정된 로그 채널이 있다면 전송
        const logChannelId = botData.serverLogs[guildId];
        if (logChannelId) {
            const channel = guild.channels.cache.get(logChannelId);
            if (channel) await channel.send(messagePayload);
        }

        // 2. 서버장 DM 수신이 켜져있다면 전송
        if (botData.ownerDMs.includes(guildId)) {
            const owner = await guild.fetchOwner();
            if (owner) {
                await owner.send({ content: `**[${guild.name}]** 서버 인증 알림`, embeds: messagePayload.embeds });
            }
        }
    } catch (error) {
        console.error('로그 전송 실패:', error);
    }
}

// ==========================================
// 서버 실행
// ==========================================
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🌍 웹 서버 및 봇 포트 ${PORT}에서 가동 중!`));
