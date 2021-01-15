const https = require('https');

const { TVTIME_TOKEN: tvtimeToken, WEBHOOK_PATH: webhookPath } = process.env;

let options = {
    host: 'api.tvtime.com',
    path: '/v1/agenda?limit=100',
    headers: {
        Authorization: `Basic ${tvtimeToken}`,
    },
};

https.get(options, function (res) {
    let body = '';

    res.on('data', function (data) {
        body += data;
    });

    res.on('end', function () {
        let episodes = JSON.parse(body).episodes;
        if (episodes.length == 0) return;
        Notify(episodes);
    });

    res.on('error', function (e) {
        console.log('Error: ' + e.message);
    });
});

function Notify(episodes) {
    let embeds = [];
    let filtered = FilterEpisodes(episodes);

    for (var key of Object.keys(filtered)) {
        let fields = [];

        for (value of filtered[key]) {
            fields.push({
                name: `Episode: "${value.name}" (${value.season_number}x${value.number})`,
                value: `Show time: **${value.air_time}**`,
                inline: false,
            });
        }

        embeds.push({
            title: `"**${key}**"`,
            fields: fields,
            color: Math.floor(Math.random() * (16777215 - 1)) + 1,
            thumbnail: {
                url: filtered[key][0].show.images.poster['0'],
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
        console.error(e);
    });

    req.write(content);
    req.end();
}

function FilterEpisodes(episodes) {
    let nowDate = FormatDate(Date.now());
    console.log(nowDate);

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
        if (groups[e.show.name] != undefined) {
            groups[e.show.name].push(e);
        } else {
            groups[e.show.name] = [e];
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
