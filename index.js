const https = require('https');

const { TVTIME_COOKIE: tvtimeCookie, WEBHOOK_PATH: webhookPath } = process.env;
const nowDate = FormatDate(Date.now());
const options = {
    host: 'beta-app.tvtime.com',
    path: `/sidecar?o=https%3A%2F%2Fapi2.tozelabs.com%2Fv2%2Fuser%2F34490022%2Ftocome&offset=0&include_watched=1`,
    headers: {
        Authorization: `Bearer ${tvtimeCookie}`,
    },
};

console.log("Starting notify")

https.get(options, function (res) {
    let body = '';

    res.on('data', function (data) {
        body += data;
    });

    res.on('end', function () {
        let episodes = JSON.parse(body);
        if (episodes.length == 0) return;
        Notify(episodes);
    });

    res.on('error', function (e) {
        throw new Error(`Tvtime error: ${e.message}`);
    });
});

function Notify(episodes) {
    let embeds = [];
    console.log(`Founded episodes: ${episodes.map(x => `\nShow: '${x.show.name}' | Time: ${x.air_date}`)}`)

    let filtered = FilterEpisodes(episodes);

    for (var key of Object.keys(filtered)) {

        let fields = [];

        for (value of filtered[key]) {
            console.log(`After filter: Show: '${value.name}' | Time: ${value.air_date}`)

            fields.push({
                name: `Episode: "${value.name}" (Episode: ${value.number} Season: ${value.season_number})`,
                value: `Show time: **${value.air_time}**`,
                inline: false,
            });
        }

        const show = filtered[key][0].show;

        embeds.push({
            title: `"**${show.name}**"`,
            fields: fields,
            color: Math.floor(Math.random() * (16777215 - 1)) + 1,
            thumbnail: {
                url: show.all_images.poster['0'],
            },
            timestamp: new Date(Date.now()).toISOString(),
        });
    }

    var webhookContent = {
        content: '',
        username: 'TV series announcer',
        avatar_url:
            'https://lh3.googleusercontent.com/PqZe52L8quyIlo_jLuTSfrIQwbQKBTe0tt98UWqz2yagxgDRN9AD-mWoOWmpgVH30tc',
        embeds: embeds,
    };

    PostToDiscordWebHook(JSON.stringify(webhookContent));
}

function PostToDiscordWebHook(content) {
    var options = {
        hostname: 'discord.com',
        port: 443,
        path: `/api/webhooks/${webhookPath}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    };

    var req = https.request(options, (res) => {
        res.on('data', (d) => {
            process.stdout.write(d);
        });
    });

    req.on('error', (e) => {
        throw new Error(`Discord error: ${e.message}`);
    });

    req.write(content);
    req.end();
}

function FilterEpisodes(episodes) {
    console.log(`NowDate: ${nowDate}`);

    let todayEpisodes = [];

    episodes.forEach((e) => {
        if (e.air_date == nowDate) {
            todayEpisodes.push(e);
        }
    });

    return GroupEpisodes(todayEpisodes);
}

function GroupEpisodes(episodes) {
    let groups = {};

    episodes.forEach((e) => {
        if (groups[e.show.id] != undefined) {
            groups[e.show.id].push(e);
        } else {
            groups[e.show.id] = [e];
        }
    });

    return groups;
}

function FormatDate(date) {
    var d = new Date(date),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    return [year, month, day].join('-');
}
