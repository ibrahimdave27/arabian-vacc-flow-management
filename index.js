const { Client, GatewayIntentBits, EmbedBuilder, WebhookClient } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');

// ─────────────────────────────────────────────
//  CONFIG — edit these values
// ─────────────────────────────────────────────
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,

  // Channel IDs
  ATC_ONLINE_CHANNEL_ID: process.env.ATC_ONLINE_CHANNEL_ID,   // #atc-online-notifications
  DAILY_STATS_CHANNEL_ID: process.env.DAILY_STATS_CHANNEL_ID, // #daily-stats

  // Arabian vACC airports to monitor (ICAO codes)
  // UAE — all aerodromes
  UAE_AIRPORTS: [
    'OMAA', // Abu Dhabi International
    'OMAL', // Al Ain International
    'OMAE', // Al Ain En-route (CTR)
    'OMAD', // Al Bateen Executive
    'OMDW', // Al Maktoum International
    'OMDM', // Al Minhad Air Base (civil ops)
    'OMDB', // Dubai International
    'OMFJ', // Fujairah International
    'OMRK', // Ras Al Khaimah International
    'OMSJ', // Sharjah International
    'OMDI', // Das Island
    'OMDL', // Delma Island
    'OMSY', // Sir Bani Yas Island
    'OMAZ', // Zirku Island
  ],
  // Qatar
  QATAR_AIRPORTS: ['OTHH', 'OTBD'],
  // Oman
  OMAN_AIRPORTS: ['OOMS', 'OOSA'],

  // How often to poll VATSIM data (ms) — minimum 15s per VATSIM policy
  POLL_INTERVAL_MS: 15000,

  // Daily stats cron — runs at 23:55 UTC every day
  DAILY_STATS_CRON: '55 23 * * *',

  // VATSIM data feed
  VATSIM_DATA_URL: 'https://data.vatsim.net/v3/vatsim-data.json',
};

// All Arabian vACC airports combined
const ALL_ARABIAN_AIRPORTS = [
  ...CONFIG.UAE_AIRPORTS,
  ...CONFIG.QATAR_AIRPORTS,
  ...CONFIG.OMAN_AIRPORTS,
];

// ─────────────────────────────────────────────
//  STATE — track who is currently online
// ─────────────────────────────────────────────
const onlineControllers = new Map(); // callsign → controller object

// ─────────────────────────────────────────────
//  DISCORD CLIENT
// ─────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Map ICAO prefix to country name + flag emoji */
function getCountryInfo(icao) {
  if (CONFIG.UAE_AIRPORTS.includes(icao))   return { name: 'UAE',   flag: '🇦🇪' };
  if (CONFIG.QATAR_AIRPORTS.includes(icao)) return { name: 'Qatar', flag: '🇶🇦' };
  if (CONFIG.OMAN_AIRPORTS.includes(icao))  return { name: 'Oman',  flag: '🇴🇲' };
  return { name: 'Arabian vACC', flag: '🌍' };
}

/** Determine ATC position type from callsign */
function getPositionType(callsign) {
  if (callsign.endsWith('_DEL')) return { type: 'Delivery',  emoji: '📋', color: 0x9b59b6 };
  if (callsign.endsWith('_GND')) return { type: 'Ground',    emoji: '🚧', color: 0xe67e22 };
  if (callsign.endsWith('_TWR')) return { type: 'Tower',     emoji: '🗼', color: 0xe74c3c };
  if (callsign.endsWith('_APP')) return { type: 'Approach',  emoji: '📡', color: 0x3498db };
  if (callsign.endsWith('_DEP')) return { type: 'Departure', emoji: '↗️', color: 0x1abc9c };
  if (callsign.endsWith('_CTR')) return { type: 'Centre',    emoji: '🌐', color: 0x2ecc71 };
  if (callsign.endsWith('_FSS')) return { type: 'FSS',       emoji: '📻', color: 0x95a5a6 };
  return                                { type: 'ATC',        emoji: '🎙️', color: 0x7f8c8d };
}

/** Format seconds → HH:MM:SS */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

/** Parse a VATSIM logon_time string to a Date */
function parseLogonTime(logonStr) {
  return new Date(logonStr);
}

/** Extract ICAO from callsign like OMDB_1_TWR → OMDB */
function extractICAO(callsign) {
  return callsign.split('_')[0].toUpperCase();
}

// ─────────────────────────────────────────────
//  VATSIM POLL — detect connects & disconnects
// ─────────────────────────────────────────────
async function pollVatsim() {
  try {
    const { data } = await axios.get(CONFIG.VATSIM_DATA_URL, { timeout: 10000 });
    const controllers = data.controllers || [];

    // Filter to Arabian vACC controllers only (exclude OBS)
    const arabianControllers = controllers.filter(c => {
      const icao = extractICAO(c.callsign);
      return ALL_ARABIAN_AIRPORTS.includes(icao) && c.facility > 0;
    });

    const currentCallsigns = new Set(arabianControllers.map(c => c.callsign));
    const previousCallsigns = new Set(onlineControllers.keys());

    // ── Newly connected ──
    for (const controller of arabianControllers) {
      if (!previousCallsigns.has(controller.callsign)) {
        onlineControllers.set(controller.callsign, controller);
        await notifyControllerOnline(controller);
      }
    }

    // ── Disconnected ──
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
//  VATSIM STATS API — controller hours
// ─────────────────────────────────────────────

/**
 * Fetch total ATC hours for a controller from the VATSIM Stats API.
 * Returns a formatted string like "142h 30m" or null if unavailable.
 */
async function fetchControllerHours(cid) {
  try {
    // Try VATSIM API v2 first
    const url = `https://api.vatsim.net/v2/members/${cid}`;
    const { data } = await axios.get(url, { timeout: 8000 });
    // Hours are under reg_date/hours depending on API version — try both paths
    const totalMinutes =
      data?.vatsim?.atc?.atctime ??
      data?.atc?.atc_time ??
      data?.statistics?.atc_time ??
      null;
    if (totalMinutes !== null) {
      const hours = Math.floor(totalMinutes / 60);
      const mins  = totalMinutes % 60;
      return `${hours}h ${String(mins).padStart(2, '0')}m`;
    }
    // Fallback: try stats endpoint
    const statsRes = await axios.get(`https://api.vatsim.net/v2/members/${cid}/stats`, { timeout: 8000 });
    const mins2 = statsRes.data?.atc?.atc_time ?? statsRes.data?.atctime ?? null;
    if (mins2 !== null) {
      const hours = Math.floor(mins2 / 60);
      const mins  = mins2 % 60;
      return `${hours}h ${String(mins).padStart(2, '0')}m`;
    }
    return null;
  } catch (err) {
    console.error(`fetchControllerHours error for CID ${cid}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  EMBED BUILDERS
// ─────────────────────────────────────────────

// Arabian vACC logo URL — used as thumbnail in all embeds
const VACC_LOGO = 'https://cdn.vatsim.net/region-web-media/EMEA/vACCs/Arabian/logos/arabian-vacc-logo.png';

function buildOnlineEmbed(controller, totalHours) {
  const icao      = extractICAO(controller.callsign);
  const country   = getCountryInfo(icao);
  const position  = getPositionType(controller.callsign);
  const logonTime = parseLogonTime(controller.logon_time);
  const utcTime   = logonTime.toISOString().replace('T', ' ').slice(0, 16) + 'z';
  const rating    = getRatingLabel(controller.rating);

  const description = [
    `**Callsign:** ${controller.callsign}`,
    `**Frequency:** ${controller.frequency}`,
    `${controller.name} ${controller.cid} (${rating}) is online at ${utcTime}`,
    `**Total ATC Hours:** ${totalHours ?? 'Unavailable'}`,
  ].join('\n');

  return new EmbedBuilder()
    .setTitle(`${controller.callsign} is Online`)
    .setDescription(description)
    .setColor(0x2ecc71) // green left bar for online
    .setThumbnail(VACC_LOGO)
    .setFooter({ text: `Brought to you by the Arabian vACC` })
    .setTimestamp();
}

function buildOfflineEmbed(controller, sessionDuration, updatedHours) {
  const endTime  = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'z';
  const rating   = getRatingLabel(controller.rating);

  const description = [
    `${controller.name} ${controller.cid} (${rating}) is now offline`,
    `**End Time:** ${endTime}`,
    `**Session Duration:** ${sessionDuration}`,
    `**Total ATC Hours:** ${updatedHours ?? 'Unavailable'}`,
  ].join('\n');

  return new EmbedBuilder()
    .setTitle(`${controller.callsign} Disconnected`)
    .setDescription(description)
    .setColor(0xe74c3c) // red left bar for disconnect
    .setThumbnail(VACC_LOGO)
    .setFooter({ text: `Brought to you by the Arabian vACC` })
    .setTimestamp();
}

/** Convert VATSIM numeric rating to label */
function getRatingLabel(rating) {
  const RATINGS = { 1: 'OBS', 2: 'S1', 3: 'S2', 4: 'S3', 5: 'C1', 7: 'C3', 8: 'I1', 10: 'I3', 11: 'SUP', 12: 'ADM' };
  return RATINGS[rating] || `Rating ${rating}`;
}

// ─────────────────────────────────────────────
//  NOTIFICATIONS
// ─────────────────────────────────────────────

async function notifyControllerOnline(controller) {
  try {
    const channel    = await client.channels.fetch(CONFIG.ATC_ONLINE_CHANNEL_ID);
    const totalHours = await fetchControllerHours(controller.cid);
    const embed      = buildOnlineEmbed(controller, totalHours);
    await channel.send({ embeds: [embed] });
    console.log(`✅ ${controller.callsign} connected (hours: ${totalHours ?? 'n/a'})`);
  } catch (err) {
    console.error('Failed to send online notification:', err.message);
  }
}

async function notifyControllerOffline(controller) {
  try {
    const channel = await client.channels.fetch(CONFIG.ATC_ONLINE_CHANNEL_ID);

    // Calculate session duration
    const logonTime    = parseLogonTime(controller.logon_time);
    const durationSec  = Math.floor((Date.now() - logonTime.getTime()) / 1000);
    const duration     = formatDuration(durationSec);

    // Small delay before fetching hours — VATSIM Stats API can lag a few seconds after disconnect
    await new Promise(r => setTimeout(r, 5000));
    const updatedHours = await fetchControllerHours(controller.cid);

    const embed = buildOfflineEmbed(controller, duration, updatedHours);
    await channel.send({ embeds: [embed] });
    console.log(`🔴 ${controller.callsign} disconnected (${duration}, total hours: ${updatedHours ?? 'n/a'})`);
  } catch (err) {
    console.error('Failed to send offline notification:', err.message);
  }
}

// ─────────────────────────────────────────────
//  DAILY STATS
// ─────────────────────────────────────────────

/** Airport display names */
const AIRPORT_NAMES = {
  // UAE
  OMAA: 'Abu Dhabi International Airport',
  OMAL: 'Al Ain International Airport',
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
  // Qatar
  OTHH: 'Hamad International Airport',
  OTBD: 'Doha International Airport',
  // Oman
  OOMS: 'Muscat International Airport',
  OOSA: 'Salalah International Airport',
};

/**
 * Fetch today's flight stats from Statsim.net
 * Endpoint: https://statsim.net/api/airport/{icao}/daily
 * Returns { departures, arrivals } or null
 */
async function fetchAirportStats(icao) {
  try {
    const url = `https://statsim.net/api/airport/${icao}/daily`;
    const { data } = await axios.get(url, { timeout: 8000 });
    // statsim returns an array of entries — take today's
    if (Array.isArray(data) && data.length > 0) {
      const today = data[data.length - 1];
      return { departures: today.departures ?? 0, arrivals: today.arrivals ?? 0 };
    }
    return { departures: 0, arrivals: 0 };
  } catch {
    return null;
  }
}

async function buildCountryStatsEmbed(countryName, flag, airports) {
  const lines = [];
  let totalDep = 0, totalArr = 0;

  for (const icao of airports) {
    const stats = await fetchAirportStats(icao);
    if (!stats) continue;
    if (stats.departures === 0 && stats.arrivals === 0) continue; // skip quiet airports

    const name = AIRPORT_NAMES[icao] || icao;
    lines.push(`**${flag} ${icao} – ${name}**\nDepartures: ${stats.departures}\nArrivals: ${stats.arrivals}`);
    totalDep += stats.departures;
    totalArr += stats.arrivals;
  }

  if (lines.length === 0) return null;

  const description = lines.join('\n\n');
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  return new EmbedBuilder()
    .setTitle(`${flag}  Daily Stats – ${countryName}`)
    .setDescription(`✈️  **Flight Stats**\n\n${description}`)
    .addFields({ name: 'Totals', value: `Departures: **${totalDep}** · Arrivals: **${totalArr}**`, inline: false })
    .setColor(0xf5a623)
    .setFooter({ text: `Brought to you by the Arabian vACC • Stats courtesy of statsim.net` })
    .setTimestamp();
}

async function sendDailyStats() {
  console.log('📊 Sending daily stats...');
  try {
    const channel = await client.channels.fetch(CONFIG.DAILY_STATS_CHANNEL_ID);

    const regions = [
      { name: 'UAE',   flag: '🇦🇪', airports: CONFIG.UAE_AIRPORTS   },
      { name: 'Qatar', flag: '🇶🇦', airports: CONFIG.QATAR_AIRPORTS },
      { name: 'Oman',  flag: '🇴🇲', airports: CONFIG.OMAN_AIRPORTS  },
    ];

    for (const region of regions) {
      const embed = await buildCountryStatsEmbed(region.name, region.flag, region.airports);
      if (embed) await channel.send({ embeds: [embed] });
      await new Promise(r => setTimeout(r, 1000)); // small delay between messages
    }

    console.log('✅ Daily stats sent');
  } catch (err) {
    console.error('Failed to send daily stats:', err.message);
  }
}

// ─────────────────────────────────────────────
//  BOT READY
// ─────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Monitoring ${ALL_ARABIAN_AIRPORTS.length} Arabian vACC airports`);

  // Pre-populate current online controllers (so we don't spam on startup)
  try {
    const { data } = await axios.get(CONFIG.VATSIM_DATA_URL, { timeout: 10000 });
    for (const c of data.controllers || []) {
      const icao = extractICAO(c.callsign);
      if (ALL_ARABIAN_AIRPORTS.includes(icao) && c.facility > 0) {
        onlineControllers.set(c.callsign, c);
        console.log(`  Pre-loaded online: ${c.callsign}`);
      }
    }
  } catch (err) {
    console.error('Failed to pre-load controllers:', err.message);
  }

  // Start polling VATSIM every 15 seconds
  setInterval(pollVatsim, CONFIG.POLL_INTERVAL_MS);

  // Schedule daily stats at 23:55 UTC
  cron.schedule(CONFIG.DAILY_STATS_CRON, sendDailyStats, { timezone: 'UTC' });

  console.log('🕐 Daily stats scheduled at 23:55 UTC');
});

// ─────────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────────
client.login(CONFIG.DISCORD_TOKEN);
