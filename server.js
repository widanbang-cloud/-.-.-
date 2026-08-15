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
    serverBlacklists: {},     // 타서버(Guild) ID 차단 목록으로 사용됨
    serverIpBlacklists: {},   
    ipRecords: {}, 
    altLimits: {},
    verifyRoles: {}           
};
if (fs.existsSync(DATA_FILE)) botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));

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
    
    new SlashCommandBuilder().setName('인증패널설치').setDescription('인증 버튼이 포함된 패널을 설치합니다. (관리자용)')
        .addRoleOption(option => option.setName('역할').setDescription('인증 성공 시 지급할 역할(팀)').setRequired(true))
        .addChannelOption(option => option.setName('채널').setDescription('패널을 설치할 채널 (미입력 시 현재 채널)').setRequired(false)),
    
    // 🛑 타서버 차단 관련 명령어 (유저 -> 서버아이디 문자열로 변경)
    new SlashCommandBuilder().setName('서버차단').setDescription('특정 타서버에 소속된 유저의 인증을 차단하고 킥합니다.')
        .addStringOption(option => option.setName('서버아이디').setDescription('차단할 타서버의 ID').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단해제').setDescription('특정 타서버의 차단을 해제합니다.')
        .addStringOption(option => option.setName('서버아이디').setDescription('차단 해제할 타서버의 ID').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단목록').setDescription('차단된 타서버 ID 목록을 확인합니다.'),
    
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

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 접근 거부: 서버 관리자 권한이 필요합니다.', ephemeral: true });
    }

    const { commandName, guildId } = interaction;

    if (commandName === '서버지정') {
        botData.serverLogs[guildId] = interaction.channelId;
        saveData();
        await interaction.reply({ content: '✅ 이 채널로 인증 로그가 확실하게 전송됩니다.', ephemeral: true });
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
    } else if (commandName === '인증패널설치') {
        const role = interaction.options.getRole('역할');
        const channel = interaction.options.getChannel('채널') || interaction.channel;

        botData.verifyRoles[guildId] = role.id;
        saveData();

        const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify+guilds&state=${guildId}`;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛡️ 디스코드 보안 인증 시스템')
            .setDescription(`서버 이용을 위해 **[인증하기]** 버튼을 눌러 보안 인증 및 IP 확인을 진행해 주세요.\n\n> 인증 완료 시 자동으로 **<@&${role.id}>** 역할이 지급됩니다.`)
            .setFooter({ text: '안전한 서버 환경을 위한 필수 절차입니다.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔐 인증하기 (IP 확인 및 동의)').setStyle(ButtonStyle.Link).setURL(oauthUrl)
        );

        await channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: `✅ 성공적으로 패널을 설치했습니다! (지급 역할: ${role.name})`, ephemeral: true });
    } 
    
    // 🛑 타서버 차단 로직 적용
    else if (commandName === '서버차단') {
        const targetServerId = interaction.options.getString('서버아이디').trim();
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(targetServerId)) botData.serverBlacklists[guildId].push(targetServerId);
        saveData();
        await interaction.reply({ content: `🚨 서버 ID **${targetServerId}** 에 소속된 유저는 앞으로 인증 시 즉시 **추방(Kick)** 됩니다.`, ephemeral: true });
    } else if (commandName === '서버차단해제') {
        const targetServerId = interaction.options.getString('서버아이디').trim();
        if (botData.serverBlacklists[guildId]) {
            botData.serverBlacklists[guildId] = botData.serverBlacklists[guildId].filter(id => id !== targetServerId);
        }
        saveData();
        await interaction.reply({ content: `✅ 타서버 ID **${targetServerId}** 의 차단이 해제되었습니다.`, ephemeral: true });
    } else if (commandName === '서버차단목록') {
        const list = botData.serverBlacklists[guildId] || [];
        const serverList = list.join('\n') || '차단된 타서버가 없습니다.';
        await interaction.reply({ content: `📜 **차단된 타서버 ID 목록:**\n${serverList}`, ephemeral: true });
    } 

    else if (commandName === 'ip차단') {
        const ip = interaction.options.getString('아이피').trim();
        if (!botData.serverIpBlacklists[guildId]) botData.serverIpBlacklists[guildId] = [];
        if (!botData.serverIpBlacklists[guildId].includes(ip)) botData.serverIpBlacklists[guildId].push(ip);
        saveData();
        await interaction.reply({ content: `🛑 IP 주소 **[ ${ip} ]** 가 차단되었습니다.`, ephemeral: true });
    } else if (commandName === 'ip차단해제') {
        const ip = interaction.options.getString('아이피').trim();
        if (botData.serverIpBlacklists[guildId]) {
            botData.serverIpBlacklists[guildId] = botData.serverIpBlacklists[guildId].filter(item => item !== ip);
        }
        saveData();
        await interaction.reply({ content: `✅ IP 주소 **[ ${ip} ]** 의 차단이 해제되었습니다.`, ephemeral: true });
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
// 🌍 웹 서버 세팅 (웹 페이지 및 콜백)
// ==========================================
app.set('trust proxy', true);

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

app.get('/auth/discord/callback', async (req, res) => {
    const { code, state: guildId } = req.query; 
    if (!code || !guildId) return res.send('<h2 style="color:red;text-align:center;margin-top:50px;">❌ 비정상적인 접근입니다.</h2>');

    const userIP = getClientIp(req);
    let ipInfoText = '기본 IP만 수집됨';
    let isVpnOrProxy = false;

    // ProxyCheck 
    try {
        const apiKey = process.env.PROXYCHECK_API_KEY || '';
        if(apiKey) {
            const proxyUrl = `https://proxycheck.io/v2/${userIP}?key=${apiKey}&vpn=1&asn=1`;
            const proxyRes = await axios.get(proxyUrl);
            if (proxyRes.data && proxyRes.data[userIP]) {
                const ipData = proxyRes.data[userIP];
                ipInfoText = `🌍 **${ipData.country || '알 수 없음'}** / ISP: ${ipData.provider || 'ISP 알 수 없음'}`;
                if (ipData.proxy === 'yes') isVpnOrProxy = true;
            }
        }
    } catch (e) { console.error("ProxyCheck 에러:", e.message); }

    if (isVpnOrProxy) {
        return res.send('<h1 style="color:red;text-align:center;">🛡️ VPN/프록시 접속 차단됨</h1>');
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

        // ==========================================
        // 🔍 1. 유저가 가입된 전체 서버 목록 확인 (핵심)
        // ==========================================
        const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        const userGuilds = guildsRes.data;

        // 1-1. 우리 서버에 있는지 1차 확인
        const isInServer = userGuilds.some(guild => guild.id === guildId);
        if (!isInServer) {
            return res.send('<h2 style="color:red;text-align:center;margin-top:50px;">❌ 해당 디스코드 서버에 먼저 입장한 후 인증해주세요.</h2>');
        }

        // ==========================================
        // 🚫 2. 타서버(블랙리스트) 소속 여부 및 IP 강제 킥 
        // ==========================================
        const blacklistedServers = botData.serverBlacklists[guildId] || [];
        // 유저가 가입된 서버 중 블랙리스트에 등록된 타서버가 있는지 찾기
        const foundBlacklistServer = userGuilds.find(guild => blacklistedServers.includes(guild.id));

        if (foundBlacklistServer || botData.serverIpBlacklists[guildId]?.includes(userIP)) {
            let kickReason = foundBlacklistServer ? `웹 인증: 차단된 타서버(${foundBlacklistServer.name}) 소속 유저` : '웹 인증: IP 차단 대상자';
            
            try {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(userData.id).catch(() => null);
                if (member) {
                    await member.kick(kickReason); // 발견 즉시 킥!
                    console.log(`[킥 실행] ${userData.username} 님을 추방했습니다. 이유: ${kickReason}`);
                }
            } catch (e) {
                console.error(`[킥 실패] ${userData.username} 님 추방 실패 (봇 권한 부족)`);
            }

            return res.send(`
                <h1 style="color:red;text-align:center;margin-top:50px;">🚫 접근 차단됨</h1>
                <p style="text-align:center;">${foundBlacklistServer ? `차단된 적대 서버 <b>[ ${foundBlacklistServer.name} ]</b> 에 소속되어 있어<br>` : '차단된 IP로 접속하여<br>'}서버에서 즉시 추방(Kick) 되었습니다.</p>
            `);
        }

        // ⛔ 3. 부계정 다중 접속 컷
        if (!botData.ipRecords[guildId]) botData.ipRecords[guildId] = {};
        if (!botData.ipRecords[guildId][userIP]) botData.ipRecords[guildId][userIP] = [];
        const ipUsers = botData.ipRecords[guildId][userIP];

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

        // 🎖️ 4. 100% 역할 지급 로직
        const roleId = botData.verifyRoles[guildId];
        let roleSuccess = false;
        if (roleId) {
            try {
                const guild = await client.guilds.fetch(guildId);
                let member = await guild.members.fetch(userData.id).catch(() => null);
                if (member) {
                    await member.roles.add(roleId);
                    console.log(`[성공] ${userData.username} 님에게 역할 지급 완료!`);
                    roleSuccess = true;
                }
            } catch (roleErr) {
                console.error(`[실패] 역할 지급 실패. 봇 권한/순위를 확인하세요.`);
            }
        }

        const isAlt = ipUsers.length > 1;
        const logEmbed = new EmbedBuilder()
            .setColor(isAlt ? 0xFF0000 : 0x00FF00)
            .setTitle('🔐 디스코드 웹 인증 완료')
            .setThumbnail(`https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`)
            .addFields(
                { name: '👤 유저 정보', value: `<@${userData.id}> (${userData.username})`, inline: true },
                { name: '🌐 접속 IP', value: userIP, inline: true },
                { name: '📍 위치 및 통신사', value: ipInfoText, inline: false },
                { name: '🎖️ 역할 지급 상태', value: roleSuccess ? '✅ 지급 성공' : '❌ 지급 실패 (봇 권한 확인 요망)', inline: false }
            )
            .setFooter({ text: isAlt ? `⚠️ 다중 계정 경고` : '✅ 정상적인 인증 접근' })
            .setTimestamp();

        await sendLog(guildId, { embeds: [logEmbed] });

        res.send(`<h2 style="color:green;text-align:center;margin-top:50px;">✅ 인증 완료되었습니다. 디스코드로 돌아가주세요.</h2>`);

    } catch (error) {
        console.error("오류 발생:", error);
        res.send('<h2 style="color:red;text-align:center;">❌ 인증 처리 중 오류가 발생했습니다.</h2>');
    }
});

// ==========================================
// 📬 무조건 보내는 로그 시스템
// ==========================================
async function sendLog(guildId, payload) {
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) return;

        const channelId = botData.serverLogs[guildId];
        if (channelId) {
            try {
                const channel = await guild.channels.fetch(channelId);
                if (channel) await channel.send(payload);
            } catch (err) {
                console.error(`[오류] 채널 로그 전송 실패.`);
            }
        }

        if (botData.ownerDMs.includes(guildId)) {
            try {
                const owner = await guild.fetchOwner();
                if (owner) {
                    await owner.send({ 
                        content: `🚨 **[${guild.name}]** 서버에서 새로운 인증 로그가 접수되었습니다.`, 
                        embeds: payload.embeds 
                    });
                }
            } catch (err) {
                console.error(`[오류] 서버장 DM 전송 실패.`);
            }
        }
    } catch (e) {
        console.error('로그 전송 오류:', e);
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🌍 시스템 포트 ${PORT} 가동 완료!`));

