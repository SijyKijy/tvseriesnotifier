const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4;
const RETRY_PAUSE_MS = 2500;
const MAX_PROFILE_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_MESSAGE_LENGTH = 6000;

const { TVMAZE_PROFILE, TVMAZE_COUNTRIES, WEBHOOK_PATHS, DRY_RUN, TEST_DATE } = process.env;

if (require.main === module) {
    main().catch((error) => {
        console.log(`Fatal: ${error.message}`);
        process.exit(1);
    });
}

async function main() {
    const dryRun = Boolean(DRY_RUN);
    const webhookPaths = dryRun ? [] : parseWebhookPaths();
    if (!TVMAZE_PROFILE) {
        throw new Error('TVMAZE_PROFILE is required, e.g. users/336089/sijykijy');
    }
    const countries = (TVMAZE_COUNTRIES || 'US,GB,JP').split(',').map((c) => c.trim()).filter(Boolean);

    const todayMsk = resolveMskDate();
    const dayStartMs = Date.parse(`${todayMsk}T00:00:00+03:00`);
    const yesterdayMsk = formatMskDate(new Date(dayStartMs - DAY_MS));
    console.log(`MSK date: ${todayMsk}${TEST_DATE ? ' (TEST_DATE)' : ''}, dry run: ${dryRun}, countries: ${countries.join(',')}`);

    const followedShowIds = await fetchFollowedShowIds(TVMAZE_PROFILE);
    const scheduleItems = await fetchSchedules([todayMsk, yesterdayMsk], countries);
    const todayEpisodes = filterTodayEpisodes(scheduleItems, followedShowIds, dayStartMs, todayMsk);

    if (todayEpisodes.length === 0) {
        console.log('no episodes today');
        return;
    }

    const messages = buildMessages(todayEpisodes);
    const embedCount = messages.reduce((count, message) => count + message.embeds.length, 0);
    console.log(`Prepared ${messages.length} message(s) with ${embedCount} embed(s)`);

    if (dryRun) {
        messages.forEach((message, index) => {
            console.log(`DRY_RUN message ${index + 1}/${messages.length}:`);
            console.log(JSON.stringify(message));
        });
        return;
    }

    await postMessages(messages, webhookPaths);
}

function parseWebhookPaths() {
    if (!WEBHOOK_PATHS) {
        throw new Error('WEBHOOK_PATHS is required when DRY_RUN is not set');
    }
    let paths;
    try {
        paths = JSON.parse(WEBHOOK_PATHS);
    } catch {
        throw new Error('WEBHOOK_PATHS must be a JSON array like ["id/token"]');
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !p)) {
        throw new Error('WEBHOOK_PATHS must be a non-empty JSON array of "id/token" strings');
    }
    return paths;
}

function resolveMskDate() {
    if (!TEST_DATE) {
        return formatMskDate(new Date());
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(TEST_DATE)) {
        throw new Error(`TEST_DATE must be YYYY-MM-DD, got '${TEST_DATE}'`);
    }
    return TEST_DATE;
}

function formatMskDate(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function formatMskTime(airstamp) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(airstamp));
}

async function fetchFollowedShowIds(profile) {
    const showIds = new Set();
    let pagesFetched = 0;
    let headers = {};
    for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
        const url = `https://www.tvmaze.com/${profile}/followed?show-page=${page}&per-page=200`;
        let html = await fetchTvmazeText(url, headers);
        if (isBrowserCheckPage(html)) {
            headers = { Cookie: await resolveBrowserCheckCookie(html) };
            html = await fetchTvmazeText(url, headers);
            if (isBrowserCheckPage(html)) {
                throw new Error('browser check not passed for profile page');
            }
        }
        pagesFetched++;
        const sizeBefore = showIds.size;
        for (const match of html.matchAll(/href="\/shows\/(\d+)\//g)) {
            showIds.add(Number(match[1]));
        }
        console.log(`Profile page ${page}: ${showIds.size - sizeBefore} new show id(s)`);
        if (showIds.size === sizeBefore) {
            break;
        }
    }
    if (showIds.size === 0) {
        throw new Error('profile parsing failed or profile is private');
    }
    console.log(`Followed shows: ${showIds.size} (from ${pagesFetched} page(s))`);
    return showIds;
}

async function fetchSchedules(dates, countries) {
    const items = [];
    for (const date of dates) {
        const webSchedule = await fetchTvmazeJson(`https://api.tvmaze.com/schedule/web?date=${date}`);
        console.log(`Schedule web ${date}: ${webSchedule.length} episode(s)`);
        for (const episode of webSchedule) {
            items.push({ episode, show: episode._embedded?.show });
        }
        for (const country of countries) {
            const countrySchedule = await fetchTvmazeJson(`https://api.tvmaze.com/schedule?country=${country}&date=${date}`);
            console.log(`Schedule ${country} ${date}: ${countrySchedule.length} episode(s)`);
            for (const episode of countrySchedule) {
                items.push({ episode, show: episode.show });
            }
        }
    }
    return items;
}

function filterTodayEpisodes(scheduleItems, followedShowIds, dayStartMs, todayMsk) {
    const dayEndMs = dayStartMs + DAY_MS;
    const seenEpisodeIds = new Set();
    const todayEpisodes = [];
    for (const { episode, show } of scheduleItems) {
        if (!show || !followedShowIds.has(show.id) || seenEpisodeIds.has(episode.id)) {
            continue;
        }
        seenEpisodeIds.add(episode.id);
        const airstampMs = episode.airstamp ? Date.parse(episode.airstamp) : NaN;
        const airsToday = Number.isNaN(airstampMs)
            ? episode.airdate === todayMsk
            : airstampMs >= dayStartMs && airstampMs < dayEndMs;
        console.log(`Followed show match: '${show.name}' S${episode.season}E${episode.number}, airstamp=${episode.airstamp}, airdate=${episode.airdate} -> ${airsToday ? 'today (MSK)' : 'not today (MSK)'}`);
        if (airsToday) {
            todayEpisodes.push({ episode, show });
        }
    }
    console.log(`Episodes for today: ${todayEpisodes.length}`);
    return todayEpisodes;
}

function buildMessages(episodeItems) {
    const shows = new Map();
    for (const { episode, show } of episodeItems) {
        if (!shows.has(show.id)) {
            shows.set(show.id, { show, episodes: [] });
        }
        shows.get(show.id).episodes.push(episode);
    }

    const embeds = [];
    for (const { show, episodes } of shows.values()) {
        episodes.sort((a, b) => ((a.season ?? 0) - (b.season ?? 0)) || ((a.number ?? 0) - (b.number ?? 0)));
        const title = `"**${show.name}**"`;
        const maxFieldsLength = MAX_MESSAGE_LENGTH - title.length - 1;
        let chunk = [];
        let chunkLength = 0;
        const pushEmbed = () => {
            const embed = {
                title,
                fields: chunk,
                color: Math.floor(Math.random() * (16777215 - 1)) + 1,
                timestamp: new Date().toISOString(),
            };
            if (show.image?.medium) {
                embed.thumbnail = { url: show.image.medium };
            }
            embeds.push(embed);
            chunk = [];
            chunkLength = 0;
        };
        for (const episode of episodes) {
            const field = {
                name: `Episode: "${episode.name ?? `Episode ${episode.number}`}" (Episode: ${episode.number} Season: ${episode.season})`,
                value: `Show time: **${episode.airstamp ? formatMskTime(episode.airstamp) : 'TBA'}**`,
                inline: false,
            };
            const fieldLength = field.name.length + field.value.length;
            if (chunk.length > 0 && (chunk.length >= MAX_FIELDS_PER_EMBED || chunkLength + fieldLength > maxFieldsLength)) {
                pushEmbed();
            }
            chunk.push(field);
            chunkLength += fieldLength;
        }
        if (chunk.length > 0) {
            pushEmbed();
        }
    }

    const messages = [];
    let currentLength = 0;
    for (const embed of embeds) {
        const embedLength = embed.title.length + embed.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
        const current = messages[messages.length - 1];
        if (!current || current.embeds.length >= MAX_EMBEDS_PER_MESSAGE || currentLength + embedLength >= MAX_MESSAGE_LENGTH) {
            messages.push({ content: '', username: 'TV series announcer', embeds: [embed] });
            currentLength = embedLength;
        } else {
            current.embeds.push(embed);
            currentLength += embedLength;
        }
    }
    return messages;
}

async function postMessages(messages, webhookPaths) {
    let acceptedWebhooks = 0;
    for (let webhookIndex = 0; webhookIndex < webhookPaths.length; webhookIndex++) {
        let allAccepted = true;
        for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
            const delivered = await postToWebhook(webhookPaths[webhookIndex], webhookIndex, messages[messageIndex], messageIndex, messages.length);
            if (!delivered) {
                allAccepted = false;
            }
        }
        if (allAccepted) {
            acceptedWebhooks++;
        }
    }
    console.log(`Webhooks that accepted all messages: ${acceptedWebhooks}/${webhookPaths.length}`);
    if (acceptedWebhooks === 0) {
        throw new Error('no webhook accepted the notification');
    }
}

async function postToWebhook(path, webhookIndex, message, messageIndex, messageCount) {
    const body = JSON.stringify(message);
    const label = `Webhook #${webhookIndex + 1}, message ${messageIndex + 1}/${messageCount}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let response;
        try {
            response = await fetch(`https://discord.com/api/webhooks/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            console.log(`${label}: request failed (${error.message})`);
            if (attempt === MAX_ATTEMPTS) {
                return false;
            }
            await sleep(RETRY_PAUSE_MS);
            continue;
        }
        const responseText = await response.text();
        if (response.status === 429) {
            const retryAfterSeconds = parseRetryAfterSeconds(responseText);
            console.log(`${label}: rate limited, retry in ${retryAfterSeconds}s`);
            if (attempt === MAX_ATTEMPTS) {
                return false;
            }
            await sleep(retryAfterSeconds * 1000);
            continue;
        }
        console.log(`${label}: status ${response.status}`);
        if (response.status >= 300) {
            console.log(responseText);
            return false;
        }
        return true;
    }
    return false;
}

function parseRetryAfterSeconds(responseText) {
    try {
        const retryAfter = Number(JSON.parse(responseText).retry_after);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return Math.min(retryAfter, 30);
        }
    } catch {}
    return 2;
}

function isBrowserCheckPage(html) {
    return html.includes('Validating your browser') || html.includes('browsercheck');
}

async function resolveBrowserCheckCookie(html) {
    const scriptSrc = html.match(/<script src="([^"]+)"/)?.[1];
    if (!scriptSrc) {
        throw new Error('browser check page has no script');
    }
    const scriptUrl = scriptSrc.startsWith('//') ? `https:${scriptSrc}` : new URL(scriptSrc, 'https://www.tvmaze.com/').href;
    const script = await fetchTvmazeText(scriptUrl);
    const cookie = script.match(/document\.cookie\s*=\s*"([^=";]+=[^";]*)/)?.[1];
    if (!cookie) {
        throw new Error(`browser check cookie not found in ${scriptUrl}`);
    }
    console.log(`Browser check: cookie '${cookie.split('=')[0]}' acquired`);
    return cookie;
}

function fetchTvmazeText(url, headers) {
    return fetchTvmaze(url, (response) => response.text(), headers);
}

function fetchTvmazeJson(url) {
    return fetchTvmaze(url, (response) => response.json());
}

async function fetchTvmaze(url, parse, headers = {}) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let response;
        try {
            response = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, ...headers },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                throw new Error(`GET ${url} failed: ${error.message}`);
            }
            console.log(`GET ${url} failed (${error.message}), retrying`);
            await sleep(RETRY_PAUSE_MS);
            continue;
        }
        if (response.ok) {
            return parse(response);
        }
        if (response.status !== 429 && response.status < 500) {
            throw new Error(`GET ${url}: unexpected status ${response.status}`);
        }
        if (attempt === MAX_ATTEMPTS) {
            throw new Error(`GET ${url}: status ${response.status} after ${MAX_ATTEMPTS} attempts`);
        }
        console.log(`GET ${url}: status ${response.status}, retrying`);
        await sleep(RETRY_PAUSE_MS);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { buildMessages };
