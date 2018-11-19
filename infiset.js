
const Redis = require('ioredis');

const redis = new Redis({port: 7777, enableOfflineQueue: false});

const dateformat = () => {
    const now = new Date();
    return `${now.getMinutes()}:${now.getSeconds()}.${('000' + now.getMilliseconds()).slice(-3)}`
}

redis.on('close', () => {
    if (redis.stream.remoteAddress) // not a reconnect event
        console.log(`[${redis.stream.remoteAddress}:${redis.stream.remotePort}] conn CLOSED`);
});

redis.on('error', (err, data) => {
    let pref = redis.stream.remoteAddress ? `${redis.stream.remoteAddress}:${redis.stream.remotePort}` : `NOTCONN`;
    console.log(`[${pref}] ERR: ${err}`);
});

redis.on('reconnecting', (data) => {
    console.log(`${dateformat()} RECONNECTING in ms ${data}`);
});

let cnt = 0;
function doit() {
    setInterval(() => {
        // console.log(`sending SADD cmd ${cnt}`);
        cnt += 1
        redis.sadd('cnt', cnt).then(() => {
            console.log(`${dateformat()} CNT ${cnt}`);
        })
        .catch((err) => {
            console.log(`${dateformat()} ERROR sending command: ${err}`);
        })
    }, 100);
}

let once;
redis.on('ready', () => {
    console.log(`[${redis.stream.remoteAddress}:${redis.stream.remotePort}] READY`);

    if (!once) {
        once = true;
        redis.del('cnt', doit);
    }
});

