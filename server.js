require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

// ==========================================
// 🔒 IP 커스텀 암호화 (치환 규칙)
// ==========================================
const encodeMap = { '0':'x', '1':'a', '2':'b', '3':'c', '4':'d', '5':'e', '6':'f', '7':'g', '8':'h', '9':'i', '.':'z', ':':'y' };
const decodeMap = { 'x':'0', 'a':'1', 'b':'2', 'c':'3', 'd':'4', 'e':'5', 'f':'6', 'g':'7', 'h':'8', 'i':'9', 'z':'.', 'y':':' };

function encodeIP(ip) {
    return String(ip).toLowerCase().split('').map(c => encodeMap[c] || c).join('');
}

function decodeIP(encoded) {
    return String(encoded).split('').map(c => decodeMap[c] || c).join('');
}

// ==========================================
// 🗂️ 데이터베이스 세팅
// ==========================================
let botData = { 
    serverLogs: {}, 
    ownerDMs: [], 
    serverBlacklists: {},     
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
    new SlashCommandBuilder().setName('채널지정').setDescription('이 채널을 보안 인증 및 킥 로그 채널로 지정합니다. (관리자용)'),
    new SlashCommandBuilder().setName('채널지정취소').setDescription('로그 채널 지정을 해제합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정').setDescription('인증/킥 로그를 서버장 DM으로 수신합니다. (관리자용)'),
    new SlashCommandBuilder().setName('서버장지정취소').setDescription('서버장 DM 수신을 해제합니다. (관리자용)'),
    
    new SlashCommandBuilder().setName('인증패널설치').setDescription('인증 버튼이 포함된 패널을 설치합니다. (관리자용)')
        .addRoleOption(option => option.setName('역할').setDescription('인증 성공 시 지급할 역할').setRequired(true))
        .addChannelOption(option => option.setName('채널').setDescription('패널을 설치할 채널 (미입력 시 현재 채널)').setRequired(false)),
    
    new SlashCommandBuilder().setName('서버차단').setDescription('특정 타서버에 소속된 유저의 인증을 차단하고 킥합니다.')
        .addStringOption(option => option.setName('서버아이디').setDescription('차단할 타서버의 ID').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단해제').setDescription('특정 타서버의 차단을 해제합니다.')
        .addStringOption(option => option.setName('서버아이디').setDescription('차단 해제할 타서버의 ID').setRequired(true)),
    new SlashCommandBuilder().setName('서버차단목록').setDescription('차단된 타서버 ID 목록을 확인합니다.'),
    
    new SlashCommandBuilder().setName('ip차단').setDescription('특정 IP 주소의 웹 인증을 차단합니다.')
        .addStringOption(option => option.setName('아이피').setDescription('차단할 IP 주소').setRequired(true)),
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
    console.log('⚠️ [안내] 데이터 파일(json) 유출 등 서버 호스팅 환경에서 발생한 보안 사고는 전적으로 서버 운영자 책임이며, 봇 개발자에게 책임이 없습니다.');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, user } = interaction;
    const adminCommands = ['채널지정', '채널지정취소', '서버장지정', '서버장지정취소', '인증패널설치', '서버차단', '서버차단해제', '서버차단목록', 'ip차단', 'ip차단해제', '부계확인', '부계차단설정'];

    if (adminCommands.includes(commandName) && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 접근 거부: 서버 관리자 권한이 필요합니다.', ephemeral: true });
    }

    if (commandName === '채널지정') {
        botData.serverLogs[guildId] = interaction.channelId;
        saveData();
        await interaction.reply({ content: '✅ 이 채널로 모든 인증 통과 로그 및 차단 유저 **암살(킥) 로그**가 전송됩니다.', ephemeral: true });
    } else if (commandName === '채널지정취소') {
        delete botData.serverLogs[guildId];
        saveData();
        await interaction.reply({ content: '✅ 지정된 로그 채널이 해제되었습니다.', ephemeral: true });
    } else if (commandName === '서버장지정') {
        if (!botData.ownerDMs.includes(guildId)) botData.ownerDMs.push(guildId);
        saveData();
        await interaction.reply({ content: '✅ 앞으로 인증/킥 로그를 서버장님 DM으로 쏴드립니다.', ephemeral: true });
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
            .setDescription(`서버 이용을 위해 **[인증하기]** 버튼을 눌러 보안 인증을 진행해 주세요.\n\n> 인증 완료 시 자동으로 **<@&${role.id}>** 역할이 지급됩니다.`)
            .setFooter({ text: '안전한 서버 환경을 위한 필수 절차입니다.' });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔐 인증하기').setStyle(ButtonStyle.Link).setURL(oauthUrl)
        );
        await channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: `✅ 성공적으로 패널을 설치했습니다! (지급 역할: ${role.name})`, ephemeral: true });
    } else if (commandName === '서버차단') {
        const targetServerId = interaction.options.getString('서버아이디').trim();
        if (!botData.serverBlacklists[guildId]) botData.serverBlacklists[guildId] = [];
        if (!botData.serverBlacklists[guildId].includes(targetServerId)) botData.serverBlacklists[guildId].push(targetServerId);
        saveData();
        await interaction.reply({ content: `🚨 타서버 ID **${targetServerId}** 에 소속된 유저는 앞으로 인증 시 조용히 **추방(Kick)** 됩니다.`, ephemeral: true });
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
    } else if (commandName === 'ip차단') {
        const ip = interaction.options.getString('아이피').trim();
        const safeIp = encodeIP(ip); // 입력받은 IP 암호화
        if (!botData.serverIpBlacklists[guildId]) botData.serverIpBlacklists[guildId] = [];
        if (!botData.serverIpBlacklists[guildId].includes(safeIp)) botData.serverIpBlacklists[guildId].push(safeIp);
        saveData();
        await interaction.reply({ content: `🛑 IP 주소 **[ ${ip} ]** 가 차단되었습니다. (DB에는 암호화되어 안전하게 저장됨)`, ephemeral: true });
    } else if (commandName === 'ip차단해제') {
        const ip = interaction.options.getString('아이피').trim();
        const safeIp = encodeIP(ip); // 해제할 IP도 암호화해서 DB와 대조
        if (botData.serverIpBlacklists[guildId]) {
            botData.serverIpBlacklists[guildId] = botData.serverIpBlacklists[guildId].filter(item => item !== safeIp);
        }
        saveData();
        await interaction.reply({ content: `✅ IP 주소 **[ ${ip} ]** 의 차단이 해제되었습니다.`, ephemeral: true });
    } else if (commandName === '부계확인') {
        const serverIps = botData.ipRecords[guildId] || {};
        let result = [];
        for (const [safeIp, users] of Object.entries(serverIps)) {
            if (users.length > 1) {
                // 관리자가 볼 때는 살짝 가려서 복호화된 형태로 보여줌
                const realIp = decodeIP(safeIp);
                const maskedIp = realIp.replace(/\.\d+$/, '.***'); 
                result.push(`**식별된 기기 (IP: ${maskedIp})** (총 ${users.length}개 계정)\n └ 계정: ${users.map(id => `<@${id}>`).join(', ')}`);
            }
        }
        if (result.length === 0) return interaction.reply({ content: '✅ 다중 계정(부계) 접근 기록이 없습니다.', ephemeral: true });
        
        let replyMsg = `🚨 **동일 시스템 다중 계정(부계정) 추적 결과** 🚨\n\n${result.join('\n\n')}`;
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
            await interaction.reply({ content: `🛡️ 방어벽 가동: 이제 동일 환경에서는 **최대 ${limit}개**의 계정만 인증 가능합니다.`, ephemeral: true });
        }
    }
});

// ==========================================
// 🎨 HTML 렌더링 템플릿
// ==========================================
const getErrorHTML = (title, message, icon = '❌') => `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
        body { background-color: #1e1f22; color: #dbdee1; font-family: 'Pretendard', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background-color: #2b2d31; padding: 40px; border-radius: 12px; border-top: 6px solid #ed4245; box-shadow: 0 8px 24px rgba(0,0,0,0.3); text-align: center; max-width: 400px; }
        h1 { color: #ed4245; margin-top: 0; font-size: 24px; display: flex; align-items: center; justify-content: center; gap: 8px; }
        p { font-size: 15px; color: #b5bac1; line-height: 1.6; margin-bottom: 0; }
    </style>
</head>
<body>
    <div class="box">
        <h1>${icon} ${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>
`;

const getSuccessHTML = (user, userIP) => {
    const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256` : `https://cdn.discordapp.com/embed/avatars/0.png`;
    let bannerStyle = 'background-color: #5865F2;';
    if (user.banner) bannerStyle = `background-image: url('https://cdn.discordapp.com/banners/${user.id}/${user.banner}.png?size=512'); background-size: cover; background-position: center;`;
    else if (user.accent_color) bannerStyle = `background-color: #${user.accent_color.toString(16).padStart(6, '0')};`;

    return `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>인증 완료</title>
        <style>
            @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
            body { background-color: #1e1f22; color: #dbdee1; font-family: 'Pretendard', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background-color: #2b2d31; width: 360px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); overflow: hidden; position: relative; }
            .banner { width: 100%; height: 120px; ${bannerStyle} }
            .avatar-wrapper { position: absolute; top: 76px; left: 16px; width: 92px; height: 92px; border-radius: 50%; background-color: #2b2d31; display: flex; justify-content: center; align-items: center; }
            .avatar { width: 80px; height: 80px; border-radius: 50%; background-image: url('${avatarUrl}'); background-size: cover; background-position: center; }
            .content { padding: 55px 20px 20px; }
            .username { font-size: 20px; font-weight: 700; color: #f2f3f5; margin: 0; }
            .userid { font-size: 14px; color: #b5bac1; margin-top: 4px; }
            .ip-box { background-color: #1e1f22; padding: 10px 14px; border-radius: 8px; margin-top: 20px; font-size: 13px; color: #b5bac1; display: flex; justify-content: space-between; align-items: center; }
            .ip-box span { color: #f2f3f5; font-weight: 600; font-family: monospace; }
            .footer { text-align: center; font-size: 13px; color: #57F287; margin-top: 20px; font-weight: 700; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="banner"></div>
            <div class="avatar-wrapper"><div class="avatar"></div></div>
            <div class="content">
                <h2 class="username">${user.global_name || user.username}</h2>
                <div class="userid">@${user.username}</div>
                <div class="ip-box">
                    <span>나의 접속 IP:</span>
                    <span>${userIP}</span>
                </div>
                <div class="footer">✅ 인증이 완료되었습니다. 창을 닫아주세요.</div>
            </div>
        </div>
    </body>
    </html>
    `;
};

// ==========================================
// 🌍 웹 서버 세팅
// ==========================================
app.set('trust proxy', true);

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

app.get('/auth/discord/callback', async (req, res) => {
    const { code, state: guildId } = req.query; 
    if (!code || !guildId) return res.send(getErrorHTML('비정상적인 접근', '유효하지 않은 요청입니다. 디스코드에서 다시 시도해주세요.'));

    const userIP = getClientIp(req);
    const safeIP = encodeIP(userIP); // 💥 데이터베이스 저장용 암호화 IP
    let isVpnOrProxy = false;

    // 우회 프로그램 검사 (검사 시에는 진짜 IP를 사용함)
    try {
        const apiKey = process.env.PROXYCHECK_API_KEY || '';
        if(apiKey) {
            const proxyUrl = `https://proxycheck.io/v2/${userIP}?key=${apiKey}&vpn=1&asn=1`;
            const proxyRes = await axios.get(proxyUrl);
            if (proxyRes.data && proxyRes.data[userIP]) {
                if (proxyRes.data[userIP].proxy === 'yes') isVpnOrProxy = true;
            }
        }
    } catch (e) { console.error("ProxyCheck 에러:", e.message); }

    if (isVpnOrProxy) {
        return res.send(getErrorHTML('VPN/Proxy 감지됨', '보안을 위해 VPN 또는 우회 프로그램을 켠 상태로는 인증할 수 없습니다.<br><br><b style="color:white; font-size:16px;">VPN을 끄고 다시 부탁드립니다.</b>', '🛡️'));
    }

    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code', code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        const userData = userRes.data;

        const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        const userGuilds = guildsRes.data;

        const isInServer = userGuilds.some(guild => guild.id === guildId);
        if (!isInServer) return res.send(getErrorHTML('서버 입장 필요', '해당 디스코드 서버에 먼저 입장한 후 다시 인증해주세요.'));

        // ==========================================
        // 🛑 서버 차단 (조용히 Kick 로직 및 전용 로그)
        // ==========================================
        const blacklistedServers = botData.serverBlacklists[guildId] || [];
        const foundBlacklistServer = userGuilds.find(guild => blacklistedServers.includes(guild.id));

        // IP 차단 확인 (저장된 안전한 IP 텍스트와 대조)
        if (foundBlacklistServer || botData.serverIpBlacklists[guildId]?.includes(safeIP)) {
            let kickReason = foundBlacklistServer ? `서버차단 기능 작동: 적대 서버(${foundBlacklistServer.name}) 소속 유저` : '웹 인증: IP 차단 대상자';
            let kickSuccess = false;

            try {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(userData.id).catch(() => null);
                if (member) { await member.kick(kickReason); kickSuccess = true; }
            } catch (e) { console.error(`[킥 실패] 봇 권한 부족`); }

            const logEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🥷 타서버 블랙리스트 유저 암살(킥) 완료')
                .setThumbnail(userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png')
                .addFields(
                    { name: '대상 유저:', value: `<@${userData.id}>\n(@${userData.username})`, inline: false },
                    { name: '차단 사유:', value: kickReason, inline: false },
                    { name: '처리 결과:', value: kickSuccess ? '✅ 서버에서 조용히 킥 당함' : '❌ 추방 실패 (봇 역할 권한이 대상 유저보다 낮은지 확인)', inline: false }
                )
                .setFooter({ text: '※ 유저의 웹 화면에는 정상 인증된 것처럼 위장되었습니다.' })
                .setTimestamp();

            await sendLog(guildId, { embeds: [logEmbed] });
            return res.send(getSuccessHTML(userData, userIP)); // 화면에는 본인 IP를 띄워줌
        }

        // ==========================================
        // 🛑 내부 시스템 전용 IP 부계정 카운트
        // ==========================================
        if (!botData.ipRecords[guildId]) botData.ipRecords[guildId] = {};
        if (!botData.ipRecords[guildId][safeIP]) botData.ipRecords[guildId][safeIP] = []; // 암호화된 IP로 기록
        const ipUsers = botData.ipRecords[guildId][safeIP];

        const limit = botData.altLimits[guildId];
        if (limit && limit > 0 && !ipUsers.includes(userData.id) && ipUsers.length >= limit) {
            return res.send(getErrorHTML('부계정 방어벽 작동', `동일 환경에서 허용된 계정 수(${limit}개)를 초과했습니다.`, '🛑'));
        }

        if (!ipUsers.includes(userData.id)) {
            ipUsers.push(userData.id);
            saveData(); 
        }

        const sameIpCount = ipUsers.length;
        let altRiskPercent = 0;
        if (sameIpCount === 2) altRiskPercent = 50;
        else if (sameIpCount === 3) altRiskPercent = 80;
        else if (sameIpCount >= 4) altRiskPercent = 100;

        const roleId = botData.verifyRoles[guildId];
        let roleSuccess = false;
        if (roleId) {
            try {
                const guild = await client.guilds.fetch(guildId);
                let member = await guild.members.fetch(userData.id).catch(() => null);
                if (member) { await member.roles.add(roleId); roleSuccess = true; }
            } catch (roleErr) { console.error(`[실패] 역할 지급 실패`); }
        }

        const userDisplayName = userData.global_name ? `${userData.global_name} (@${userData.username})` : `@${userData.username}`;
        const embedColor = altRiskPercent >= 80 ? 0xED4245 : (altRiskPercent >= 50 ? 0xFEE75C : 0x57F287);

        const logEmbed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle('🔐 디스코드 보안 인증 성공')
            .setThumbnail(userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png')
            .addFields(
                { name: '디스코드 닉네임:', value: `<@${userData.id}>\n(${userDisplayName})`, inline: false },
                { name: '부계정 의심:', value: `**${altRiskPercent}%**`, inline: false },
                { name: '🎖️ 역할 지급:', value: roleSuccess ? '✅ 지급 완료' : '❌ 지급 실패 (봇 권한 확인 필요)', inline: false }
            )
            .setFooter({ text: sameIpCount > 1 ? `⚠️ 주의: 부계정 의심 감지됨` : '✅ 정상 접근 (단일 계정)' })
            .setTimestamp();

        await sendLog(guildId, { embeds: [logEmbed] });

        res.send(getSuccessHTML(userData, userIP));

    } catch (error) {
        console.error("오류 발생:", error);
        res.send(getErrorHTML('인증 처리 오류', '디스코드 서버와 통신하는 중 문제가 발생했습니다. 관리자에게 문의하세요.'));
    }
});

// ==========================================
// 📬 로그 자동 전송 시스템
// ==========================================
async function sendLog(guildId, payload) {
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) return;

        const channelId = botData.serverLogs[guildId];
        const hasOwnerDM = botData.ownerDMs.includes(guildId);
        let logSent = false;

        if (channelId) {
            try {
                const channel = await guild.channels.fetch(channelId);
                if (channel) { await channel.send(payload); logSent = true; }
            } catch (err) { console.error(`[오류] 채널 로그 전송 실패.`); }
        }

        if (hasOwnerDM) {
            try {
                const owner = await guild.fetchOwner();
                if (owner) {
                    await owner.send({ content: `🚨 **[${guild.name}]** 새로운 보안 로그가 접수되었습니다.`, embeds: payload.embeds });
                    logSent = true;
                }
            } catch (err) { console.error(`[오류] 서버장 DM 전송 실패.`); }
        }

        if (!logSent) {
            try {
                const owner = await guild.fetchOwner();
                if (owner) {
                    await owner.send({ content: `⚠️ (자동 알림) **[${guild.name}]** 로그 채널이 설정되지 않아 자동으로 발송되었습니다.\n\`/채널지정\` 명령어로 채널을 등록하실 수 있습니다.`, embeds: payload.embeds });
                }
            } catch (err) { console.error(`[오류] 서버장 강제 DM 전송 실패.`); }
        }
    } catch (e) {
        console.error('로그 전송 오류:', e);
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🌍 시스템 포트 ${PORT} 가동 완료!`));

