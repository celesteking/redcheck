
const net = require('net');
const util = require('util');
const fs = require('fs');
const Redis = require('ioredis');

let opts = {
    hosts: [ // sentinels
        { host: '192.168.112.2', port: 26379 },
        { host: '192.168.112.3', port: 26379 },
        { host: '192.168.112.4', port: 26379 }
    ],
    quorum_num: 2, // number of nodes to consider quorum
    quorum_event_window: 5000, // in ms

    retryStrategy: (times) => { return 5000; }, // fixed conn retry interval, in ms

    precheck: true, // retrieve & update master before main run
    precheck_masters: ['mred1'], // master names

    notify: {
        socket: '/run/haproxy.sock', // writable haproxy socket
        map_file: '/etc/haproxy/maps/redmaster',  // map file
        map_command: (master, ip) => {
            return `${opts.notify.map_file} ${master} ${ip}`;
        },
        show_command: () => {
            return `show map ${opts.notify.map_file}\n`;
        },
        kill_command: (master, ip) => {
            return `shutdown sessions server b:${master}:${ip}/s:${master}:${ip}\n`;
        }
    }
};

// ---------------------------------------------------------------------------
class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject
            this.resolve = resolve
        })
        this.then = this.promise.then.bind(this.promise);
        this.catch = this.promise.catch.bind(this.promise);
    }
}

class Serial {
    constructor() {
        this.tasks = null;
    }
    singularity (fn) {
        let deferral = new Deferred();

        let done = (data) => {
            if (this.tasks.length === 0)
                this.tasks = null;

            deferral.resolve(data);

            if (!!this.tasks && this.tasks.length > 0) {
                this.tasks.shift()();
            }
        }

        if (!this.tasks) {
            this.tasks = []
            fn().then(done);
        } else {
            this.tasks.push(() => { fn().then(done) });
        }

        return deferral.promise;
    }
}
// ---------------------------------------------------------------------------

const serlock = new Serial();
let quorum_data = {};
let pclients;

function socksend(cmd) {
    return new Promise((resolve, reject) => {
        let sock = net.connect(opts.notify.socket, () => {
            console.log(`>>>> sending to ${opts.notify.socket}: ${cmd}`.trim());
            sock.write(cmd);
        });

        sock.on('data', (data) => {
            // sock.end();
            const reply = data.toString().trim();
            console.log(`<<<< reply: "${reply}"`);
            resolve(reply);
        });

        sock.on('error', err => {
            reject(err);
        })
    });
}

function update_haproxy_map(master, newip, newport) {
    const map_cmd = opts.notify.map_command(master, newip);

    return socksend(`set map ${map_cmd}\n`)
            .then(reply => {
                if (reply.match('entry not found'))
                    return socksend(`add map ${map_cmd}\n`)
                else
                    return reply
            })
            .then(reply => {
                if (reply.match('^$'))
                    return newip
                else
                    return new Error('didnt get proper reply');
            });
}

function kill_haproxy_sessions(master, oldip) {
    const cmd = opts.notify.kill_command(master, oldip);

    return socksend(cmd)
            .then(reply => {
                if (reply.match('^$'))
                    return true
                else
                    throw new Error("ERR didn't get proper reply when killing sessions");
            });
}

function save_haproxy_map() {
    return new Promise((resolve, reject) => {
        return socksend(opts.notify.show_command())
                .then((data) => {
                    let mapdata = data.trim().replace(/^\w+?\s(\w+)\s(\w+)\b/mg, '$1 $2');
                    fs.writeFile(opts.notify.map_file, mapdata, (err) => {
                        if (err) return reject(err);
                        console.log(`Map file ${opts.notify.map_file} updated.`);
                        resolve();
                    });
                });
    });
}

function quorum_cb (master, oldip, oldport, newip, newport) {
    console.log(`>>>> quorum cb called for ${master} > ${newip}`);

    return serlock.singularity(() => {
        return update_haproxy_map(master, newip, newport)
                .then(() => {
                    const saveit = () =>
                        save_haproxy_map()
                            .catch(err => {
                                console.log(`ERR saving maps to file: ${err}`);
                                return err;
                            });

                    if (oldip) // this is a master transition
                        return kill_haproxy_sessions(master, oldip).then(saveit)
                    else // this is a preliminary master check
                        return saveit();
                })
                .then(() => newip)
                .catch(err => {
                    console.log(`ERR sending master update via haproxy socket: ${err}`);
                    return err;
                });
    });

}

function init_red_instance(red_args) {
    const host = red_args['host'];
    const redis = new Redis(Object.assign(red_args, (({ retryStrategy }) => ({ retryStrategy }))(opts)));

    redis.subscribe('+switch-master', (err, count) => {
        if (err)
            console.log("ERROR subscribing: " + err)
        else
            console.log(`[${host}] subscribed to ${count} channel`);
    });

    redis.on('message', (chan, msg) => {
        // switch-master <master name> <oldip> <oldport> <newip> <newport>
        let [master, oldip, oldport, newip, newport] = msg.split(" ");
        console.log(`[${host}] said master ${master} moved ${oldip}:${oldport} >>> ${newip}:${newport}`);

        let qdata = (quorum_data[master] = quorum_data[master] || {'voters': new Set()});
        // console.log('qdata: ' + util.inspect(qdata, {depth: 1, colors: true}));

        let voting_cleanup = () => {
            clearTimeout(qdata['timer']);
            delete qdata['timer'];
            qdata['voters'] = new Set();
        }

        if (qdata['last_elected'] === newip)
            return console.log(`[${host}]<${master}> ignoring vote for already elected master **${newip}**`);

        if (!qdata['timer']) { // first event
            console.log(`[${host}]<${master}> First event: electing ${newip} ------------------------`);

            qdata['voters'].add(host);
            qdata['ip'] = newip;

            qdata['timer'] = setTimeout(() => {
                voting_cleanup();
                console.log(`<${master}> ---------- no quorum inside election window for ${qdata['ip']} -------------`);
            }, opts.quorum_event_window);

        } else { // inside quorum window
            console.log(`[${host}]<${master}> Followup event electing **${newip}**`);

            if (qdata['ip'] !== newip)
                return console.log(`[${host}]<${master}> ALERT: wanted to elect a different master **${newip}**, ignoring...`);

            if (qdata['voters'].add(host).size === opts.quorum_num) {
                qdata['last_elected'] = newip;
                voting_cleanup();
                console.log(`<${master}> ------------------------- Elected ${qdata['ip']} --------------------------`);
                return quorum_cb(master, oldip, oldport, newip, newport);
            }
        }
    });

    redis.on('ready', () => {
        console.log(`[${redis.stream.remoteAddress}:${redis.stream.remotePort}] READY`);
    });

    redis.on('close', () => {
        if (redis.stream.remoteAddress) // not a reconnect event
            console.log(`[${redis.stream.remoteAddress}:${redis.stream.remotePort}] conn CLOSED`);
    });

    redis.on('error', (err, data) => {
        let pref = redis.stream.remoteAddress ? `${redis.stream.remoteAddress}:${redis.stream.remotePort}` : `(${host})NOTCONN`;
        console.log(`[${pref}] ERR: ${err}`);
    });

    return redis;
}

//
function main() {
    if (pclients) return;

    pclients = opts.hosts.map(init_red_instance);

    process.on('SIGINT', function() {
        console.log("Caught interrupt signal, exiting.");
        for (const master in quorum_data){
            if (quorum_data[master]['timer'])
                clearTimeout(quorum_data[master]['timer']);
        }
        pclients.map((r) => { r.disconnect() });
    });
}

//
function get_current_master() {
    console.log('Preliminary master retrieval starting...')
    const preclient = new Redis(Object.assign({enableOfflineQueue: false, connectTimeout: 5000, reconnectOnError: false, retryStrategy: false}, opts.hosts[0]));
    preclient.on('ready', () => {
        Promise.all(opts.precheck_masters.map((master) => {
            return preclient.sendCommand(new Redis.Command('sentinel', ['master', master], {replyEncoding: 'utf8'}))
                .then((data) => {
                    let res = data.reduce((acc, cur, i) => {if (i % 2) acc[data[i-1]] = data[i]; return acc;}, {}) // array to object
                    console.log(`<${master}> got master IP: ${res.ip}`);
                    return quorum_cb(master, null, null, res.ip, res.port);
                })
                .catch((err) => {
                    console.log(`<${master}> error getting master: ${err}`);
                    return err;
                });
        })).then((res) => {
            console.log('Completed preliminary master resolution.', 'The outcome was:' + util.inspect(res));
            preclient.disconnect();
            main();
        });
    })
    preclient.on('error', (err) => {
        console.log(`Got an error when trying to retrieve master info, proceeding nevertheless. ${err}`);
        main()
    })
}

//
if (opts.precheck)
    get_current_master()
else
    main();

