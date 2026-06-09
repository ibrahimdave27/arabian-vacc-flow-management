require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');
const cron  = require('node-cron');
const axios = require('axios');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  DISCORD_TOKEN:          process.env.DISCORD_TOKEN,
  CLIENT_ID:              process.env.CLIENT_ID,
  GUILD_ID:               process.env.GUILD_ID,

  POLL_INTERVAL_MS:  15000,
  TRAFFIC_CHECK_CRON: '*/5 * * * *',
  VATSIM_DATA_URL: 'https://data.vatsim.net/v3/vatsim-data.json',

  UAE_AIRPORTS: [
    'OMAA', 'OMAL', 'OMAE', 'OMAD', 'OMDW',
    'OMDM', 'OMDB', 'OMFJ', 'OMRK', 'OMSJ',
    'OMDI', 'OMDL', 'OMSY', 'OMAZ',
  ],
  QATAR_AIRPORTS: ['OTHH', 'OTBD'],
  OMAN_AIRPORTS:  ['OOMS', 'OOSA'],
};

const ALL_ARABIAN_AIRPORTS = [
  ...CONFIG.UAE_AIRPORTS,
  ...CONFIG.QATAR_AIRPORTS,
  ...CONFIG.OMAN_AIRPORTS,
];

const AIRPORT_NAMES = {
  OMAA: 'Abu Dhabi International Airport',
  OMAL: 'Al Ain International Airport',
  OMAE: 'Al Ain ACC',
  OMAD: 'Al Bateen Executive Airport',
  OMDW: 'Al Maktoum International Airport',
  OMDM: 'Al Minhad Airport',
  OMDB: 'Dubai International Airport',
  OMFJ: 'Fujairah International Airport',
  OMRK: 'Ras Al Khaimah International Airport',
  OMSJ: 'Sharjah International Airport',
  OMDI: 'Das Island Aerodrome',
  OMDL: 'Delma Island Aerodrome',
  OMSY: 'Sir Bani Yas Island Airport',
  OMAZ: 'Zirku Island Aerodrome',
  OTHH: 'Hamad International Airport',
  OTBD: 'Doha International Airport',
  OOMS: 'Muscat International Airport',
  OOSA: 'Salalah International Airport',
};

const AIRPORT_COORDS = {
  OMAA: { lat: 24.4330, lon: 54.6511 },
  OMAL: { lat: 24.2617, lon: 55.6092 },
  OMAD: { lat: 24.4283, lon: 54.4581 },
  OMDW: { lat: 24.8963, lon: 55.1617 },
  OMDM: { lat: 25.0269, lon: 55.3617 },
  OMDB: { lat: 25.2528, lon: 55.3644 },
  OMFJ: { lat: 25.1122, lon: 56.3240 },
  OMRK: { lat: 25.6136, lon: 55.9388 },
  OMSJ: { lat: 25.3286, lon: 55.5172 },
  OTHH: { lat: 25.2731, lon: 51.6081 },
  OTBD: { lat: 25.2611, lon: 51.5653 },
  OOMS: { lat: 23.5933, lon: 58.2844 },
  OOSA: { lat: 17.0387, lon: 54.0911 },
  OMDI: { lat: 25.1500, lon: 52.8667 },
  OMDL: { lat: 24.5000, lon: 52.3333 },
  OMSY: { lat: 24.0000, lon: 52.5833 },
  OMAZ: { lat: 24.8667, lon: 53.0833 },
};

const VACC_LOGO = process.env.VACC_LOGO_URL || '';

const COLOR_ONLINE  = 0x00ff00;
const COLOR_OFFLINE = 0xff0000;
const COLOR_TRAFFIC = 0x007bff;
const COLOR_STATS   = 0xf5a623;

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const onlineControllers = new Map(); 
const pausedAirports    = new Map();  
const alertedAirports   = new Set();  

const DEFAULT_THRESHOLD = 5;
const airportThresholds = new Map();

let dailyStatsCron = null;
let dailyStatsTime = { hour: 23, minute: 55 }; 

// ─────────────────────────────────────────────
//  DISCORD CLIENT
// ─────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function getRatingLabel(rating) {
  const R = { 1:'OBS', 2:'S1', 3:'S2', 4:'S3', 5:'C1', 7:'C3', 8:'I1', 10:'I3', 11:'SUP', 12:'ADM' };
  return R[rating] || `Rating ${rating}`;
}

function extractICAO(callsign) {
  return callsign.split('_')[0].toUpperCase();
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function toUtcZ(date) {
  return date.toISOString().slice(11, 16) + 'z';
}

function isAirportPaused(icao) {
  if (!pausedAirports.has(icao)) return false;
  if (Date.now() >= pausedAirports.get(icao)) {
    pausedAirports.delete(icao);
    return false;
  }
  return true;
}

function getDistanceNM(lat1, lon1, lat2, lon2) {
  const R    = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────
//  EMBED BUILDERS
// ─────────────────────────────────────────────

function buildOnlineEmbed(controller) {
  const rating    = getRatingLabel(controller.rating);
  const logonTime = new Date(controller.logon_time);
  const timeZ     = toUtcZ(logonTime);

  const embed = new EmbedBuilder()
    .setTitle(`${controller.callsign} is Online`)
    .setDescription(
      `**Callsign:** ${controller.callsign}\n` +
      `**Frequency:** ${controller.frequency}\n` +
      `${controller.name} ${controller.cid} (${rating}) is online at ${timeZ}`
    )
    .setColor(COLOR_ONLINE)
    .setFooter({ text: 'Brought to you by the Arabian vACC' });

  if (VACC_LOGO) embed.setThumbnail(VACC_LOGO);
  return embed;
}

function buildOfflineEmbed(controller, sessionDuration) {
  const rating  = getRatingLabel(controller.rating);
  const endTime = toUtcZ(new Date());

  const embed = new EmbedBuilder()
    .setTitle(`${controller.callsign} Disconnected`)
    .setDescription(
      `${controller.name} ${controller.cid} (${rating}) is now offline\n` +
      `**End Time:** ${endTime}\n` +
      `**Session Duration:** ${sessionDuration}`
    )
    .setColor(COLOR_OFFLINE)
    .setFooter({ text: 'Brought to you by the Arabian vACC' });

  if (VACC_LOGO) embed.setThumbnail(VACC_LOGO);
  return embed;
}

function buildTrafficEmbed(icao, prefiles, departures, arrivalsWithin100nm, controllersOnline) {
  const name = AIRPORT_NAMES[icao] || icao;
  const controllerText = controllersOnline.length > 0
    ? `**Controllers Online:** ${controllersOnline.join(', ')}`
    : `There are no controllers online for this airport`;

  const embed = new EmbedBuilder()
    .setTitle(`Traffic Alert: ${name}`)
    .setDescription(
      `**Airport:** ${icao} (${name})\n` +
      `**Prefiles:** ${prefiles}\n` +
      `**Departures:** ${departures}\n` +
      `**Arriving Aircraft (within 100NM):** ${arrivalsWithin100nm}\n` +
      controllerText
    )
    .setColor(COLOR_TRAFFIC)
    .setFooter({ text: 'Brought to you by the Arabian vACC' });

  if (VACC_LOGO) embed.setThumbnail(VACC_LOGO);
  return embed;
}

// ─────────────────────────────────────────────
//  ATC NOTIFICATIONS
// ─────────────────────────────────────────────

async function notifyControllerOnline(controller) {
  try {
    const channel = await client.channels.fetch(CONFIG.ATC_ONLINE_CHANNEL_ID);
    await channel.send({ embeds: [buildOnlineEmbed(controller)] });
    console.log(`✅ ${controller.callsign} connected`);
  } catch (err) {
    console.error('Failed to send online notification:', err.message);
  }
}

async function notifyControllerOffline(controller) {
  try {
    const channel     = await client.channels.fetch(CONFIG.ATC_ONLINE_CHANNEL_ID);
    const logonTime   = new Date(controller.logon_time);
    const durationSec = Math.floor((Date.now() - logonTime.getTime()) / 1000);
    const duration    = formatDuration(durationSec);
    await channel.send({ embeds: [buildOfflineEmbed(controller, duration)] });
    console.log(`🔴 ${controller.callsign} disconnected (${duration})`);
  } catch (err) {
    console.error('Failed to send offline notification:', err.message);
  }
}

// ─────────────────────────────────────────────
//  VATSIM POLL — ATC connects / disconnects
// ─────────────────────────────────────────────

async function pollVatsim() {
  try {
    const { data } = await axios.get(CONFIG.VATSIM_DATA_URL, { timeout: 10000 });
    const controllers = data.controllers || [];

    const arabianControllers = controllers.filter(c => {
      const icao = extractICAO(c.callsign);
      return ALL_ARABIAN_AIRPORTS.includes(icao) && c.facility > 0;
    });

    const currentCallsigns  = new Set(arabianControllers.map(c => c.callsign));
    const previousCallsigns = new Set(onlineControllers.keys());

    for (const controller of arabianControllers) {
      if (!previousCallsigns.has(controller.callsign)) {
        onlineControllers.set(controller.callsign, controller);
        await notifyControllerOnline(controller);
      }
    }

    for (const [callsign, controller] of onlineControllers) {
      if (!currentCallsigns.has(callsign)) {
        onlineControllers.delete(callsign);
        await notifyControllerOffline(controller);
      }
    }
  } catch (err) {
    console.error('VATSIM poll error:', err.message);
  }
}

// ─────────────────────────────────────────────
//  TRAFFIC ALERTS
// ─────────────────────────────────────────────

async function checkTrafficAlerts() {
  try {
    const { data } = await axios.get(CONFIG.VATSIM_DATA_URL, { timeout: 10000 });
    const pilots   = data.pilots      || [];
    const prefiles = data.prefiles    || [];

    for (const icao of ALL_ARABIAN_AIRPORTS) {
      if (isAirportPaused(icao)) continue;

      const coords = AIRPORT_COORDS[icao];
      if (!coords) continue;

      const deps = pilots.filter(p =>
        p.flight_plan?.departure === icao && p.groundspeed < 50
      ).length;

      const pres = prefiles.filter(p =>
        p.flight_plan?.departure === icao
      ).length;

      const arrs = pilots.filter(p => {
        if (p.flight_plan?.arrival !== icao) return false;
        const dist = getDistanceNM(coords.lat, coords.lon, p.latitude, p.longitude);
        return dist <= 100;
      }).length;

      const combined = deps + pres + arrs;

    const threshold = airportThresholds.get(icao) ?? DEFAULT_THRESHOLD;

    if (combined < threshold) {
      alertedAirports.delete(icao);
      continue;
    }

    if (alertedAirports.has(icao)) continue;

      const controllersOnline = [...onlineControllers.keys()].filter(cs =>
        extractICAO(cs) === icao
      );

      const channel = await client.channels.fetch(CONFIG.TRAFFIC_CHANNEL_ID);
      await channel.send({
        embeds: [buildTrafficEmbed(icao, pres, deps, arrs, controllersOnline)]
      });

      alertedAirports.add(icao);
      console.log(`🚦 Traffic alert sent for ${icao} (${combined} combined)`);
    }
  } catch (err) {
    console.error('Traffic check error:', err.message);
  }
}

// ─────────────────────────────────────────────
//  DAILY STATS
// ─────────────────────────────────────────────

async function fetchAirportStats(icao) {
  try {
    const { data } = await axios.get(
      CONFIG.VATSIM_DATA_URL,
      { timeout: 10000 }
    );

    const pilots = data.pilots || [];

    const departures = pilots.filter(p =>
  p.flight_plan?.departure === icao &&
  (p.groundspeed ?? 0) > 0
).length;

    const arrivals = pilots.filter(p =>
      p.flight_plan?.arrival === icao
    ).length;

    return {
      departures,
      arrivals
    };

  } catch (err) {
    console.error(`VATSIM STATS FAILED FOR ${icao}`, err.message);

    return {
      departures: 0,
      arrivals: 0
    };
  }
}

async function buildCountryStatsEmbed(countryName, flag, airports) {
  const lines = [];
  let totalDep = 0, totalArr = 0;

  for (const icao of airports) {
    console.log(`Calling fetchAirportStats for ${icao}`);
    const stats = await fetchAirportStats(icao);
    console.log(`Returned from fetchAirportStats for ${icao}`, stats);
    if (!stats) continue;
    if (stats.departures === 0 && stats.arrivals === 0) continue;
    const name = AIRPORT_NAMES[icao] || icao;
    lines.push(`**${flag} ${icao} – ${name}**\nDepartures: ${stats.departures}\nArrivals: ${stats.arrivals}`);
    totalDep += stats.departures;
    totalArr += stats.arrivals;
  }

  console.log(
  	`${countryName}: ${lines.length} airports returned traffic`
  );

  const embed = new EmbedBuilder()
    .setTitle(`${flag}  Daily Stats – ${countryName}`)
    .setDescription(`✈️  **Flight Stats**\n\n${lines.join('\n\n')}`)
    .addFields({ name: 'Totals', value: `Departures: **${totalDep}** · Arrivals: **${totalArr}**` })
    .setColor(COLOR_STATS)
    .setFooter({ text: 'Arabian vACC • Live data from VATSIM network' })
    .setTimestamp();

  if (VACC_LOGO) embed.setThumbnail(VACC_LOGO);
  return embed;
}

async function sendDailyStats() {
  console.log('📊 Sending daily stats...');
  try {
    const channel = await client.channels.fetch(
  		CONFIG.DAILY_STATS_CHANNEL_ID
	);

	if (!channel) {
  		console.error('❌ Stats channel not found');
  		return;
	}
    const regions = [
      { name: 'UAE',   flag: '🇦🇪', airports: CONFIG.UAE_AIRPORTS   },
      { name: 'Qatar', flag: '🇶🇦', airports: CONFIG.QATAR_AIRPORTS },
      { name: 'Oman',  flag: '🇴🇲', airports: CONFIG.OMAN_AIRPORTS  },
    ];
    for (const region of regions) {
      const embed = await buildCountryStatsEmbed(region.name, region.flag, region.airports);
      if (embed) await channel.send({ embeds: [embed] });
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('✅ Daily stats sent');
  } catch (err) {
    console.error('Failed to send daily stats:', err.message);
  }
}

function scheduleDailyStats(hour, minute) {
  if (dailyStatsCron) dailyStatsCron.stop();
  dailyStatsTime = { hour, minute };
  dailyStatsCron = cron.schedule(
    `${minute} ${hour} * * *`,
    sendDailyStats,
    { timezone: 'UTC' }
  );
  console.log(`🕐 Daily stats rescheduled to ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} UTC`);
}

// ─────────────────────────────────────────────
//  SLASH COMMANDS
// ─────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check if the bot is active and responsive')
      .toJSON(),
    
  new SlashCommandBuilder()
      .setName('setairportthreshold')
      .setDescription('Set traffic alert threshold for a specific airport')
      .addStringOption(opt =>
        opt.setName('icao')
          .setDescription('Airport ICAO (e.g. OMDB)')
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName('amount')
          .setDescription('Minimum combined traffic to trigger alert')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(50)
      )
      .toJSON(),  
    
  new SlashCommandBuilder()
      .setName('thresholdstatus')
      .setDescription('Show current traffic thresholds per airport')
      .toJSON(),
    
  new SlashCommandBuilder()
    .setName('pausealerts')
    .setDescription('Pause traffic alerts for an airport for a set number of hours')
    .addStringOption(opt =>
      opt.setName('icao').setDescription('Airport ICAO code e.g. OMDB').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('hours').setDescription('How many hours to pause for').setRequired(true)
        .setMinValue(1).setMaxValue(24))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('resumealerts')
    .setDescription('Resume traffic alerts for an airport immediately')
    .addStringOption(opt =>
      opt.setName('icao').setDescription('Airport ICAO code e.g. OMDB').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pausestatus')
    .setDescription('Show which airports currently have paused traffic alerts')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('setstatstime')
    .setDescription('Change the daily UTC time that statistics are posted')
    .addIntegerOption(opt =>
      opt.setName('hour').setDescription('UTC hour (0–23)').setRequired(true)
        .setMinValue(0).setMaxValue(23))
    .addIntegerOption(opt =>
      opt.setName('minute').setDescription('UTC minute (0–59)').setRequired(true)
        .setMinValue(0).setMaxValue(59))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('statstime')
    .setDescription('Show the current daily stats posting time')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('sendstats')
    .setDescription('Manually trigger the daily stats post right now')
    .toJSON(),
];

async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'pausealerts') {
    const icao  = interaction.options.getString('icao').toUpperCase();
    const hours = interaction.options.getInteger('hours');
    if (!ALL_ARABIAN_AIRPORTS.includes(icao)) {
      return interaction.reply({ content: `❌ \`${icao}\` is not a monitored Arabian vACC airport.`, ephemeral: true });
    }
    const until = Date.now() + hours * 60 * 60 * 1000;
    pausedAirports.set(icao, until);

    const untilDate = new Date(until);
    const dateStr   = untilDate.toISOString().slice(0, 10);
    const timeStr   = toUtcZ(untilDate);
    await interaction.reply({
      content: `Traffic alerts for **${icao}** paused until ${dateStr} ${timeStr}`
    });
  }

  else if (commandName === 'resumealerts') {
    const icao = interaction.options.getString('icao').toUpperCase();
    if (pausedAirports.has(icao)) {
      pausedAirports.delete(icao);
      alertedAirports.delete(icao);
      await interaction.reply({ content: `▶️ Traffic alerts for **${icao}** have been resumed.` });
    } else {
      await interaction.reply({ content: `ℹ️ **${icao}** was not paused.`, ephemeral: true });
    }
  }
    
  else if (commandName === 'ping') {
      const sent = await interaction.reply({
        content: '🏓 Pinging...',
        fetchReply: true
      });

      const latency = sent.createdTimestamp - interaction.createdTimestamp;

      await interaction.editReply(
        `🏓 Pong!\n` +
        `⏱️ Latency: **${latency}ms**\n` +
        `🤖 API Latency: **${client.ws.ping}ms**`
      );
    }
   
  else if (commandName === 'thresholdstatus') {
      if (airportThresholds.size === 0) {
        return interaction.reply({
          content: `ℹ️ All airports are using default threshold: **${DEFAULT_THRESHOLD}**`,
          ephemeral: true
        });
      }

      const lines = [];

      for (const [icao, val] of airportThresholds) {
        lines.push(`• **${icao}** → ${val}`);
      }

      await interaction.reply({
        content:
          `🚦 **Airport Thresholds**\n\n` +
          lines.join('\n') +
          `\n\nDefault: **${DEFAULT_THRESHOLD}**`,
        ephemeral: true
      });
    }  
    
  else if (commandName === 'setairportthreshold') {
  const icao = interaction.options.getString('icao').toUpperCase();
  const amount = interaction.options.getInteger('amount');

  if (!ALL_ARABIAN_AIRPORTS.includes(icao)) {
    return interaction.reply({
      content: `❌ ${icao} is not a monitored Arabian vACC airport.`,
      ephemeral: true
    });
  }

  airportThresholds.set(icao, amount);

  await interaction.reply({
    content: `🚦 ${icao} traffic alert threshold set to **${amount} aircraft**.`,
    ephemeral: true
  });

  console.log(`🚦 Threshold updated: ${icao} = ${amount}`);
}  

  else if (commandName === 'pausestatus') {
    if (pausedAirports.size === 0) {
      return interaction.reply({ content: `✅ No airports are currently paused.`, ephemeral: true });
    }
    const lines = [];
    for (const [icao, until] of pausedAirports) {
      if (Date.now() >= until) { pausedAirports.delete(icao); continue; }
      lines.push(`• **${icao}** — paused until ${toUtcZ(new Date(until))}`);
    }
    await interaction.reply({
      content: lines.length > 0
        ? `⏸️ **Paused airports:**\n${lines.join('\n')}`
        : `✅ No airports are currently paused.`,
      ephemeral: true,
    });
  }

  else if (commandName === 'setstatstime') {
    const hour   = interaction.options.getInteger('hour');
    const minute = interaction.options.getInteger('minute');
    scheduleDailyStats(hour, minute);
    await interaction.reply({
      content: `✅ Daily stats will now post at **${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} UTC** every day.`
    });
  }

  else if (commandName === 'statstime') {
    const h = String(dailyStatsTime.hour).padStart(2, '0');
    const m = String(dailyStatsTime.minute).padStart(2, '0');
    await interaction.reply({ content: `🕐 Daily stats are currently scheduled at **${h}:${m} UTC**.`, ephemeral: true });
  }

  else if (commandName === 'sendstats') {
    await interaction.reply({ content: `📊 Sending daily stats now...` });
    await sendDailyStats();
  }
});

// ─────────────────────────────────────────────
//  BOT READY
// ─────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Monitoring ${ALL_ARABIAN_AIRPORTS.length} Arabian vACC airports`);

  await registerCommands();

  try {
    const { data } = await axios.get(CONFIG.VATSIM_DATA_URL, { timeout: 10000 });
    for (const c of data.controllers || []) {
      const icao = extractICAO(c.callsign);
      if (ALL_ARABIAN_AIRPORTS.includes(icao) && c.facility > 0) {
        onlineControllers.set(c.callsign, c);
        console.log(`  Pre-loaded: ${c.callsign}`);
      }
    }
  } catch (err) {
    console.error('Failed to pre-load controllers:', err.message);
  }

  setInterval(pollVatsim, CONFIG.POLL_INTERVAL_MS);

  cron.schedule(CONFIG.TRAFFIC_CHECK_CRON, checkTrafficAlerts, { timezone: 'UTC' });

  scheduleDailyStats(23, 55);
});

client.login(CONFIG.DISCORD_TOKEN);
