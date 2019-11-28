var net = require("net");
const util = require("util");
const Ethash = require('ethashjs')
const ethUtil = require('ethereumjs-util')
const ethHashUtil = require('ethashjs/util.js')
const levelup = require('levelup')
const memdown = require('memdown')
const request = require('request')
const chalk = require('chalk');
const stripAnsi = require('strip-ansi')
const constamp = require('console-stamp')(console, '[yyyymmdd HH:MM:ss.l]');
const logtofile = require('log-to-file');

var logfn = 'miner_test.' + new Date().getTime() + '.log';
var started = false;

// Well, this is ugly crap, should use a proper logging framework.
var realConLog = console.log;
console.log = function(...args) {
    var s = util.format(...args);
    realConLog(s);
    if (started) logtofile(stripAnsi(s), logfn);
};

// Set to true for debug logs
var debugLog = false;

// Log uncaught exceptions
process.on("uncaughtException", function(error) {
    console.error(error);
});

// Check cmd line args
if (process.argv.length != 10) {
    console.log("Usage: trm_ethash_miner_tester <localport> <epoch> <MH/s> <shares/sec> <secs between jobs> <reset after N hashrate reports> <verify shares: 1/0> <reset stats on first share: 1/0>");
    process.exit();
}

// Add a prototype function to verify a submitted nonce.
Ethash.prototype.verifySubmit = function (number, headerHash, nonce, cb) {
    var self = this
    this.loadEpoc(number, function () {
        var a = self.run(headerHash, Buffer.from(nonce, 'hex'))
        cb(a.hash)
    })
}

// Caching DB used for ethash epochs. Not much of use since we hardcode the epoch.
var cacheDB = levelup('', {
    db: memdown
})

// Used for share verification etc.
var ethash = new Ethash(cacheDB);

var d2d = function(d, len) {
    var s = Number(d).toString(10);
    while (s.length < len) {
        s = "0" + s;
    }
    return s;
}

// Returns a hex string from a digit with the given padded length. No 0x prefix.
var d2h = function(d, len) {
    var hex = Number(d).toString(16);
    len = typeof(len) === "undefined" || len === null ? len = 2 : len;
    if (len & 1) len++;

    while (hex.length < len) {
        hex = "0" + hex;
    }

    return hex;
}

// Trims a leading 0x from the given string.
var hexPfxTrim = function(s) {
    if (s.length >= 3) {
        var pfx = s.substring(0, 2);
        if (pfx === "0x" || pfx === "0X") {
            s = s.substring(2, s.length);
        }
    }
    return s;
}

// Grab/parse cmd line args
var argIdx = 2;
var localport = process.argv[argIdx++];

var epochArg = process.argv[argIdx++];
var testMHS = parseFloat(process.argv[argIdx++]);
var testSPS = parseFloat(process.argv[argIdx++]);
var secsBetweenJobs = parseInt(process.argv[argIdx++]);

// To avoid bad avgs due to slow ramp-up, we skip the first N reported hashrates.
const nrHashratePrintsToDiscard = parseInt(process.argv[argIdx++]);

var verifyShares = parseInt(process.argv[argIdx++]);
var resetStatsOnFirstShare = parseInt(process.argv[argIdx++]);

// From here, log to file as well.
started = true;

// Calculate the diff needed to produce K shares/sec with M MH/s hashrate.
// Diff1 is 0x00000000ffff0000, i.e. one share is 4295032833 hashes (2^64 / 0x00000000ffff0000).
var diff = (testMHS * 1e6) / (4295032833 * testSPS);
console.log("Derived static diff %d from a hashrate of %d MH/s and %d expected shares/sec.",
            Math.round(diff * 1e6) / 1e6, Math.round(testMHS * 1e2) / 1e2, Math.round(testSPS * 1e3) / 1e3);

// Set up our (hardcoded) diff str once and for all. We only use 64 bits.
var diffHexStr = "0x" + d2h(Math.round(0x00000000ffff0000 / diff), 16) + "0000000000000000" + "0000000000000000" + "0000000000000000";

// Global start time, we normally count from the first received share by resetting it at that point.
var startMs;

// Global vars
var nextSessionId = 0x01;
var nextExtraNonce = 0x010203;
var hasSeenShare = false;
var conns = {};

var lastShareMs = -1;
var lastShareOutageMs = -1;

// Global share and hashrate counters
var shares = {
    nrTotShares: 0,
    nrAccShares: 0,
    nrStaleShares: 0,
    nrRejShares: 0,
    hrTot: 0.0,
    hrCount: 0,
    hasResetHR: false
};

// Spawn a new job for a connection and create the JSON rpc response.
var spawnJob = function(conn) {
    
    var jobIdNum = conn.nextJobId++;
    
    // Random header
    var hdrStr = "0x";
    for (var i = 0; i < 64/4; i++) {
        hdrStr += d2h((Math.random() * 65536) & 65535, 4);
    }

    var job = {
        jobId: "0x" + d2h(jobIdNum, 6),
        seedHash: SeedHashHexStr,
        header: hdrStr,
        headerBuf: Buffer.from(hexPfxTrim(hdrStr), 'hex'),
        nonces: {}
    };

    conn.curJobId = job.jobId;
    conn.jobs[job.jobId] = job;
    
    // Purge old job. We keep the previous 10 jobs per conn.
    var oldJobId = "0x" + d2h(conn.nextJobId - 10, 6);
    delete conn.jobs[oldJobId];

    var resp;
    if (conn.nhMode) {
        resp = { "id": null,
                 "method": "mining.notify",
                 "params": [
                     hexPfxTrim(job.jobId),
                     hexPfxTrim(job.seedHash),
                     hexPfxTrim(job.header),
                     false
                 ]};
        
    } else {
        // Eth-proxy(-ish) mode
        resp = { "id": 0,
                 "jsonrpc": "2.0",
                 "result": [
                     job.header,
                     job.seedHash,
                     diffHexStr,
                     //job.jobId
                 ]};
    }
    return resp;
};

const gssConst = (Math.sqrt(5) + 1) / 2;

var calcPoissonOpt = function(target, x, n) {
	// Pr[|X − λ| ≥ x] ≤ 2e(−^2 / (2(λ+x))), x > 0
    var v = 2.0*Math.exp(-(x*x) / (2*(n+x)));
    return Math.abs(target - v);
}

var gssPoisson = function(conf, a, b, n, tol) {
	// Adapted from https://en.wikipedia.org/wiki/Golden-section_search
    var c = b - (b - a) / gssConst;
    var d = a + (b - a) / gssConst;
    //console.log("a %d b %d c %d d %d tol %d", a, b, c, d, tol);
    while (Math.abs(c - d) > tol) {
        if (calcPoissonOpt(conf, c, n) < calcPoissonOpt(conf, d, n))
            b = d
        else
            a = c

        c = b - (b - a) / gssConst;
        d = a + (b - a) / gssConst;
    }
    
    return (b + a) / 2;
}

var calcPoissonBounds = function(conf, n) {
    return gssPoisson(conf, 0, 20*Math.sqrt(n), n, 1e-5);
}

// Print hashrates (global and per active connection).
var printHashrates = function() {
    console.log(chalk.yellow.bold("Hashrates for %d active connections:"), Object.keys(conns).length);

    var gSecs = (new Date().getTime() - startMs) / 1e3;
    var gOkShares = shares.nrAccShares + shares.nrStaleShares;
    var gHashrate = gOkShares * (4295032833.0 * diff) / gSecs / 1e6;

    var gRepHashrate = (shares.hrCount > 0 ? shares.hrTot / shares.hrCount : 0) / 1e6;
    var gOffPct = gRepHashrate != 0 ? Math.round(1e4 * (gHashrate / gRepHashrate - 1)) / 1e2 : 0;
    
    var pctAccShares = Math.round(1e4 * shares.nrAccShares / shares.nrTotShares) / 1e2;
    var pctStaleShares = Math.round(1e4 * shares.nrStaleShares / shares.nrTotShares) / 1e2;
    var pctRejShares = Math.round(1e4 * shares.nrRejShares / shares.nrTotShares) / 1e2;

    console.log(chalk.yellow.bold("Global uptime: %d days, %s:%s:%s"),
                0 | (gSecs / 3600 / 24), d2d(0 | ((gSecs / 3600) % 24), 2),
                d2d(0 | ((gSecs / 60) % 60), 2), d2d(0 | (gSecs % 60), 2));
    console.log(chalk.yellow.bold("Global hashrate: %d MH/s vs %d MH/s avg reported [diff %d%%] (A%d:S%d:R%d shares, %d secs)"),
                Math.round(gHashrate*1e2)/1e2, Math.round(gRepHashrate*1e2)/1e2, gOffPct,
                shares.nrAccShares, shares.nrStaleShares, shares.nrRejShares, Math.round(gSecs));
    console.log(chalk.yellow.bold("Global stats: %d%% acc, %d%% stale, %d%% rej."),
                pctAccShares, pctStaleShares, pctRejShares);

    // Calc and present proper bounds around the reported value.
    if (gRepHashrate > 0) {
        var conf99 = calcPoissonBounds(0.01, gOkShares);
        var conf95 = calcPoissonBounds(0.05, gOkShares);

        var minHR99 = (gOkShares - conf99) * (4295032833.0 * diff) / gSecs / 1e6;
        var maxHR99 = (gOkShares + conf99) * (4295032833.0 * diff) / gSecs / 1e6;
        var minHR95 = (gOkShares - conf95) * (4295032833.0 * diff) / gSecs / 1e6;
        var maxHR95 = (gOkShares + conf95) * (4295032833.0 * diff) / gSecs / 1e6;
        
        console.log(chalk.yellow.bold("Global approx: [%d%%, %d%%] at 99% confidence, [%d%%, %d%%] at 95% confidence."),
                    Math.round(1e4 * (minHR99 / gRepHashrate - 1)) / 1e2, 
                    Math.round(1e4 * (maxHR99 / gRepHashrate - 1)) / 1e2, 
                    Math.round(1e4 * (minHR95 / gRepHashrate - 1)) / 1e2, 
                    Math.round(1e4 * (maxHR95 / gRepHashrate - 1)) / 1e2);
    }
        
    for (var sId in conns) {
        var conn = conns[sId];
        var secs = (new Date().getTime() - conn.connMs) / 1e3;
        var nrOkShares = conn.nrAccShares + conn.nrStaleShares;
        var hashrate = nrOkShares * (4295032833.0 * diff) / secs / 1e6;
        var repHashrate = (conn.hrCount > 0 ? conn.hrTot / conn.hrCount : 0) / 1e6;
        var offPct = repHashrate != 0 ? Math.round(1e4 * (hashrate / repHashrate - 1)) / 1e2 : 0;

        console.log("[%d] " + chalk.yellow("hashrate:  %d MH/s vs %d MH/s avg reported [diff %d%%] (A%d:S%d:R%d shares, %d secs)"),
                    conn.sessionId, Math.round(hashrate*1e2)/1e2, Math.round(repHashrate*1e2)/1e2, offPct,
                    conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares, Math.round(secs));
    }
};

// Print the hashrates every 10 secs.
setInterval(printHashrates, 10*1000);

// Reset start time, typically called the last time when the first global share is received.
var resetStartTime = function() {
    console.log(chalk.magenta("Resetting start time for global and all current connection hashrate calculations."));
    var nowMs = new Date().getTime();
    startMs = nowMs;
    Object.values(conns).forEach(function(c) { c.connMs = nowMs; });
}

// Main handler. Sets up all state and functions for a new connection.
var server = net.createServer(function (localsocket) {

    // Conn state object
    var conn = {
        sessionId: nextSessionId++,
        extraNonce: nextExtraNonce++,
        nextJobId: 0x100000,
        wallet: "",
        password: "",
        worker: "",
        authorized: false,
        nrTotShares: 0,
        nrAccShares: 0,
        nrStaleShares: 0,
        nrRejShares: 0,
        connMs: new Date().getTime(),
        curJobId: 0,
        hrTot: 0.0,
        hrCount: 0,
        hasResetHR: false,
        nhMode: false,
        jobs: {}
    };

    // Store all active connections
    conns[conn.sessionId] = conn;

    // Writes and flushes a single msg (JSON object, not a string)
    conn.writeObj = function(obj) {
        // Always make sure we have the jsonrpc version set.
        if (!conn.nhMode) {
            obj["jsonrpc"] = "2.0";
        }
        var msg = JSON.stringify(obj);
        if (debugLog) {
            console.log("[%d] %s:%d - send %s",
                        conn.sessionId,
                        localsocket.remoteAddress,
                        localsocket.remotePort,
                        msg
                       );
        }
        localsocket.write(msg + "\n");
    }
    
    // Setting global start time here, but it's reset with the first (globally) received share as well.
    console.log("[%d] " + chalk.magenta("Session %d connected."), conn.sessionId, conn.sessionId);
    if (!startMs) {
        startMs = conn.connMs;
    }

    
    
    // Timer to send out new jobs.
    conn.timer = function(conn) {
        if (conn.dead) return;

        var resp = spawnJob(conn);

        console.log("[%d] " + chalk.magenta("New active jobId %s."), conn.sessionId, conn.curJobId);
        conn.writeObj(resp);
        setTimeout(conn.timer, 1000*secsBetweenJobs, conn);
    };
    
    conn.checkVerifiedShare = function(rpcId, wasCurJob, hashDiff) {
        shares.nrTotShares++;
        conn.nrTotShares++;
        
        var resp;
        
        if (hashDiff >= diff) {
            // Share passed diff test
            if (wasCurJob) {
                // Share's job was the current job when the share was received.
                // This is the standard print, only print every 20th share to not flood the logs.
                shares.nrAccShares++;
                conn.nrAccShares++;
                if (shares.nrAccShares % 20 == 0) {
                    console.log("[%d] Share %s [A%d:S%d:R%d] diff %d",
                                conn.sessionId, chalk.green("ACCEPTED"),
                                conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares, hashDiff);
                }
            } else {
                // Share's job was NOT the current job when the share was received, count as stale.
                shares.nrStaleShares++;
                conn.nrStaleShares++;
                console.log("[%d] Share %s [A%d:S%d:R%d] diff %d",
                            conn.sessionId,
                            chalk.yellow("ACC-STALE"),
                            conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares, hashDiff);
            }
            
            resp = { "id": rpcId, 
                     "result": true,
                     "error": null
                   };
        } else {
            // Share didn't pass diff test, reject.
            shares.nrRejShares++;
            conn.nrRejShares++;
            resp = { "id": rpcId,
                     "result": false,
                     "error": "Low diff"
                   };
            console.log("[%d] Share %s (low diff %d < %d) [A%d:S%d:R%d]",
                        conn.sessionId, chalk.red("REJECTED"),
                        hashDiff, diff, conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares);
        }

        // Send final response.
        conn.writeObj(resp);
    }

    conn.handleShare = function(rpcId, job, nonce) {
        
        if (!job) {
            // Unknown job, send reject.
            shares.nrTotShares++;
            shares.nrRejShares++;
            conn.nrTotShares++;
            conn.nrRejShares++;
            conn.writeObj({ "id": rpcId, 
                            "result": false,
                            "error": "Unknown job"
                          });
            console.log("[%d] Share %s (unknown job) [A%d:S%d:R%d]",
                        conn.sessionId, chalk.red("REJECTED"), conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares);
            return;
        } 
        // Found job. Validate share if enabled.
        var jobId = job.jobId;
        var wasCurJob = jobId === conn.curJobId;

        // Always verify dup nonce.
        if (nonce in job.nonces) {
            // Dup share, send reject.
            shares.nrTotShares++;
            shares.nrRejShares++;
            conn.nrTotShares++;
            conn.nrRejShares++;
            conn.writeObj({ "id": rpcId, 
                            "result": false,
                            "error": "Duplicate share"
                          });
            console.log("[%d] Share %s (dup share) [A%d:S%d:R%d]",
                        conn.sessionId, chalk.red("REJECTED"), conn.nrAccShares, conn.nrStaleShares, conn.nrRejShares);
            return;
        }
        job.nonces[nonce] = true;

        // Check for long delays.
        var ms = new Date().getTime();
        if (lastShareMs > 0 && (ms - lastShareMs) >= 10000) {
			var dMs = ms - lastShareMs;
			if (lastShareOutageMs > 0) {
				var dTotMs = ms - lastShareOutageMs;
				var pct = 1e2 *  dMs / dTotMs;
				console.log(chalk.yellow.bold("Long share outage (%d secs): possible dev fee switch, %d secs since last switch, %d%% deduced dev fee."), 
					dMs/1e3, dTotMs/1e3, Math.round(1e2*pct)/1e2);
			} else {
				console.log(chalk.yellow.bold("Long share outage (%d secs): possible (first) dev fee switch."), dMs/1e3);
			}
			lastShareOutageMs = ms;
        }
        lastShareMs = ms;
        
        // Wrap handle function in a verifySubmit call or call directly depending on if
        // share verification is enabled.
        if (verifyShares) {
            ethash.verifySubmit(BlockNr, job.headerBuf, nonce, function(res) {
                // Ok, this isn't great, but prob of false negatives is ok here...
                // Diff1 is 0x00000000ffff0000, i.e. one share is 4295032833 hashes (2^64 / 0x00000000ffff0000).
                var hashStr = res.toString('hex');
                var hashDiff = 4295032833.0 / parseInt(hashStr.substring(0, 16), 16);
                conn.checkVerifiedShare(rpcId, wasCurJob, hashDiff);
            });
        } else {
            conn.checkVerifiedShare(rpcId, wasCurJob, diff);
        }
    };
    
    conn.handleFirstGlobalShare = function(rpcId) {
        hasSeenShare = true;
        console.log("[%d] Initial share %s but discarded.", conn.sessionId, chalk.green('ACCEPTED'));
        resetStartTime();
        conn.writeObj({ "id": rpcId, 
                        "result": true,
                        "error": null
                      });
    }
    
    localsocket.on('data', function(data) {
        // Parse and rebuild data
        if (debugLog) {
            console.log("[%d] %s:%d - received data:\n%s",
                        conn.sessionId,
                        localsocket.remoteAddress,
                        localsocket.remotePort,
                        data
                       );
        }

        // Split the received data into lines, assume one JSON object per line.
        try {
            var arr = ("" + data).split("\n");
            var n = arr.length;
            if (n && arr[n-1].length == 0) {
                // Trim the last empty message.
                arr.pop();
                n--;
            }
            if (debugLog) {
                console.log("[%d] %s:%d - received %d msgs/lines.",
                            conn.sessionId,
                            localsocket.remoteAddress,
                            localsocket.remotePort,
                            n
                           );
            }

            // Process all lines (JSON objects) received in this message.
            for (var i = 0; i < arr.length; i++) {
                if (debugLog) {
                    console.log("[%d] %s:%d - recv %s",
                                conn.sessionId,
                                localsocket.remoteAddress,
                                localsocket.remotePort,
                                arr[i]
                               );
                }
                
                var jd = JSON.parse(arr[i])
                if (jd && jd.method && jd.method == "mining.subscribe") {
                    conn.nhMode = true;
                    console.log("[%d] Received mining.subscribe, sending initial mining.notify", conn.sessionId);
                    conn.writeObj({ "id": jd.id,
                                    "result": [
                                        [
                                            "mining.notify",
                                            d2h(conn.sessionId, 16),
                                            "EthereumStratum/1.0.0"
                                        ],
                                        d2h(conn.extraNonce, 6)
                                    ],
                                    "error": null
                                  });
                } else if (jd && jd.method && jd.method == "mining.extranonce.subscribe") {
                    console.log("[%d] Received mining.extranonce.subscribe", conn.sessionId);
                    conn.writeObj({ "id": jd.id,
                                    "result": true,
                                    "error": null
                                  });
                    // Ethminer is an idiot miner and doesn't use the extranonce passed back from
                    // subscribe. Set it again.
                    conn.writeObj({ "id": null,
                                    "method": "mining.set_extranonce",
                                    "params" : [d2h(conn.extraNonce, 6)]
                                  });
                } else if (jd && jd.method && jd.method == "mining.authorize") {
                    conn.wallet = jd.params[0];
                    conn.password = jd.params[1];
                    console.log("[%d] Received mining.authorize (wallet %s, password %s)",
                                conn.sessionId, conn.wallet, conn.password);
                    conn.writeObj({ "id": jd.id,
                                    "result": true,
                                    "error": null
                                  });
                    conn.writeObj({ "id": null,
                                    "method": "mining.set_difficulty",
                                    "params": [diff]
                                  });
                    conn.writeObj(spawnJob(conn));
                    setTimeout(conn.timer, 1000*secsBetweenJobs, conn);
                } else if (jd && jd.method && jd.method == "mining.submit" && jd.params && jd.params.length == 3) {

                    // The very first received share is accepted but discarded and global start time is reset.
                    // This is to avoid the initial DAG build penalty, making the hashrate converging faster.
                    if (!hasSeenShare && resetStatsOnFirstShare) {
                        conn.handleFirstGlobalShare(jd.id);
                    } else {
                        // Find job
                        var jobId = "0x" + hexPfxTrim(jd.params[1]);
                        var nonce = d2h(conn.extraNonce, 6) + hexPfxTrim(jd.params[2]);
                        var job = conn.jobs[jobId];
                        
                        // Call the share handler code
                        conn.handleShare(jd.id, job, nonce);
                    }
                } else if (jd && jd.method && jd.method == "eth_login") {
                    console.log("[%d] " + chalk.magenta("Received eth_login for wallet %s, pwd %s"), conn.sessionId, jd.params[0], jd.params[1]);
                    conn.wallet = jd.params[0];
                    conn.password = jd.params[1];
                    conn.writeObj({ "id": jd.id,
                                    "result": true,
                                    "error": null
                                  });
                } else if (jd && jd.method && jd.method == "eth_submitLogin") {
                    console.log("[%d] " + chalk.magenta("Received eth_submitLogin for wallet %s"), conn.sessionId, jd.params[0]);
                    conn.wallet = jd.params[0];
                    conn.password = (jd.params.length > 1 ? jd.params[1] : "");
                    if (jd.worker) {
                        conn.worker = jd.worker;
                    }
                    conn.writeObj({ "id": jd.id,
                                    "result": true,
                                    "error": null
                                  });
                    
                } else if (jd && jd.method && jd.method == "eth_submitWork" && jd.params && jd.params.length == 3) {

                    // The very first received share is accepted but discarded and global start time is reset.
                    // This is to avoid the initial DAG build penalty, removing that factor from the calculated hashrate.
                    if (!hasSeenShare && resetStatsOnFirstShare) {
                        conn.handleFirstGlobalShare(jd.id);
                    } else {
                        // Process normal share.
                        
                        // Find job (simple scan of the conn's job dictionary).
                        var job = null;
                        for (var jId in conn.jobs) {
                            var j = conn.jobs[jId];
                            if (jd.params[1] === j.header) {
                                job = j;
                                break;
                            }
                        }

                        // Grab nonce
                        var nonce = hexPfxTrim(jd.params[0]);

                        // Call the share handler code
                        conn.handleShare(jd.id, job, nonce);
                    }
                    
                }
                else if (jd && jd.method && jd.method == "eth_getWork") {

                    if (jd.worker) {
                        conn.worker = jd.worker;
                    }
                    
                    // We only care about this the first time we see it, then we just push out jobs as defined
                    // by the cmdline arg.
                    if (!conn.curJobId) {
                        
                        console.log("[%d] " + chalk.magenta("Received first eth_getWork, pushing initial job."), conn.sessionId);
                        // Dwarfpool style, set the read rpc id on the first work response.
                        var job = spawnJob(conn);
                        job.id = jd.id;
                        conn.writeObj(job);
                        setTimeout(conn.timer, 1000*secsBetweenJobs, conn);
                    }
                }
                else if (jd && jd.method && jd.method == "eth_submitHashrate") {

                    // We don't do time-weighting of the submitted hashrate, it's just the avg of all received
                    // hashrates. Since some miners are slow to ramp up, we skip the first 5 submitted entries.
                    // We track the reported hashrate per connection as well, but we really expect the global to
                    // be the only value of interest.
                    
                    var hrStr = jd.params[0];
                    var hr = parseInt(hexPfxTrim(hrStr), 16);

                    if (shares.hrCount == nrHashratePrintsToDiscard && !shares.hasResetHR) {
                        console.log("[%d] Received %d global hashrate prints, resetting to avoid slow ramp-up bad avgs.",
                                    conn.sessionId, nrHashratePrintsToDiscard);
                        shares.hrTot = 0;
                        shares.hrCount = 0;
                        shares.hasResetHR = true;
                    }
                    if (conn.hrCount == nrHashratePrintsToDiscard && !conn.hasResetHR) {
                        console.log("[%d] " + chalk.magenta("Received %d conn hashrate prints, resetting to avoid slow ramp-up bad avgs."),
                                    conn.sessionId, nrHashratePrintsToDiscard);
                        conn.hrTot = 0;
                        conn.hrCount = 0;
                        conn.hasResetHR = true;
                    }
                    
                    conn.hrTot += hr;
                    conn.hrCount++;
                    shares.hrTot += hr;
                    shares.hrCount++;
                    console.log("[%d] " + chalk.blueBright("Reported hashrate %d MH/s"), conn.sessionId, Math.round(hr/1e6*1e2)/1e2);
                    conn.writeObj({ "id": jd.id, 
                                    "result": true,
                                    "error": null
                                  });
                }
                else {
                    console.log("[%d] %s:%d - ERROR unknown msg recvd %s",
                                conn.sessionId,
                                localsocket.remoteAddress,
                                localsocket.remotePort,
                                arr[i]
                               );
                }
            }
            
        } catch (err) {
            console.log("[%d] %s:%d - failed parsing writing data to remote to json (data type: %s) (%s)",
                        conn.sessionId,
                        localsocket.remoteAddress,
                        localsocket.remotePort,
                        typeof(data),
                        err
                       );
        }
    });

    localsocket.on('close', function(had_error) {
        console.log("[%d] %s:%d - closed",
                    conn.sessionId,
                    localsocket.remoteAddress,
                    localsocket.remotePort
                   );
        conn.dead = true;
        delete conns[conn.sessionId];
    });

});

// Epoch vars
var SeedHashHexStr = "0x0";
var BlockNr = 0;

// Executed when epoch has been set up
var startServer = function() {
    // Start listening server.
    console.log(chalk.magenta("Accepting connections on 0.0.0.0:%d"), localport);
    server.listen(localport);
}

// Set up and init ethash helpers if user has enabled share verification.
var setupShareVerificationAndStartServer = function() {
    
    // Set the remaining epoch vars.
    SeedHashHexStr = "0x" + ethHashUtil.getSeed(ethUtil.zeros(32), 0, EpochNr).toString('hex');
    BlockNr = EpochNr * ethHashUtil.params.EPOCH_LENGTH;

    if (verifyShares) {
        console.log(chalk.magenta("Loading DAG epoch %d, this will take a while (30-60 secs on slow cloud servers)."), EpochNr);
        ethash.loadEpoc(BlockNr, function() {
            console.log(chalk.magenta("Ethash epoch %d loaded."), EpochNr);
            startServer();
        });
    } else {
        startServer();
    }
}

// Wait for our epoch to be set up.

// Setup epoch variables
var EpochNr = 0;
if (epochArg == "ETH" || epochArg == "ETC") {
    // Parse from the web. Could connect to a pool instead...

    var url = "https://investoon.com/tools/dag_size";
    
    request(url, { }, (err, res, body) => {
        if (err) {
            console.log("ERROR - couldn't fetch DAG data from %s, specify the DAG epoch yourself (%s).", url, err);
            process.exit();
        }
        // This is a total hack...
        //    <td><kbd class="last_block_Ethereum">&nbsp;#9006829&nbsp;</kbd></td>
        //    <td><kbd class="last_block_EthereumClassic">&nbsp;#9269299&nbsp;</kbd></td>
        
        var hit = epochArg == "ETC" ? body.match(/last_block_EthereumClassic\">\&nbsp;\#(\d+)\&nbsp/) : body.match(/last_block_Ethereum\">\&nbsp;\#(\d+)\&nbsp/);

        if (!hit) {
            console.log("ERROR - couldn't parse DAG data from %s, specify the DAG epoch yourself (%s).", url, err);
            process.exit();
        }
        
        EpochNr = (parseInt(hit[1]) / ethHashUtil.params.EPOCH_LENGTH) | 0;
        console.log("Deduced epoch %d for %s.", EpochNr, epochArg);
        setupShareVerificationAndStartServer();
    });    
    
    
} else {
    EpochNr = parseInt(epochArg);
    console.log("Using provided epoch %d", EpochNr);
    setupShareVerificationAndStartServer();
}



