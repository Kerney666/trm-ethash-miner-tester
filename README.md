

# TRM Ethash Miner Tester
## TL;DR
The two major closed source AMD ethash miners, Claymore and Phoenix, both indicate a significant element of added hash rate of +1.5-2.3% in their displayed and reported values. Please note that this does not automatically imply ill intent. It also does not mean a higher-than-specified dev fee. However, it _does_ mean that the vast majority of AMD ethash miners would be better off running a different miner, that displayed hash rates can not be trusted, and that aforementioned miners should be updated to produce correct numbers. The open source Ethminer is an excellent example of how it's done properly. Using this tool you don't have to take our word for these claims, you can verify the results for yourself. Please note that we only make these claims for AMD-based ethash mining, we have not performed tests on Nvidia rigs.

## Quick Start Guide
This README is dense and will take 10-15 mins to read through. If you're the impatient but tech savvy type and just want to get going with testing: clone and handle the repo yourself, or download a release and unpack it into some directory on your miner machine, then run "trm_ethash_miner_tester.exe" or ("./trm_ethash_miner_tester" for Linux) for arguments. Point your miner to the pool using the ethproxy protocol and enable hash rate reports if necessary. The tool also supports the stratum protocol but hashrate reports usually work better using ethproxy. Skim through the rest of the document for important pointers and example commands. When your test is running, it is highly recommended to return and read the full document.

## Background
During the development of of TeamRedMiner's ethash kernels, we noticed unexpected discrepancies when comparing even the simplest ethash-like mem test kernels against the two major AMD closed source miners, Claymore and Phoenix miner. In short, their displayed hash rates just did not make sense and seemed bloated. This tool was built to properly probe ethash miners, and we're now releasing it so that anyone can test and prove that the displayed hash rates of said miners contains a significant element of hash rate that never appears poolside.

To further verify our suspicions, we also reverse engineered both miners, inspected their kernels and traced their OpenCL API calls at runtime to calculate the nr of enqueued hashes per time unit. These results were also clear: the nr of enqueued hashes per time unit is always significantly less than the displayed hash rate, and there is nothing special about their kernels that can explain the discrepancies. Please note: these results will **not** be released and disclosed as part of this tool as the tool itself is enough to verify our claims, albeit at a lower resolution. It is a matter of principle. If you want to hack miners, you will have to do so yourself. For our own sake, we needed to do the dirty work to get a good second opinion.

However, deducing the true hash rate of a black box miner purely by mining is a very difficult task. Most miners believe that a 24h average against a standard pool is "proof", which really can't be more wrong. In 99% of the cases, they're left with a variance several magnitudes higher than e.g. the dev fee of the closed source miner they're testing. We provide more details around this in the section below on Poisson processes. To be able to properly test ethash miners from a black box perspective, we built and open sourced this tool.

## Why this report?

TeamRedMiner will **not** add any additional extra hash rate to our displayed values. Therefore, when releasing ethash, we got a flood of comments that we're "worse" than Phoenix and Claymore, especially on Polaris cards, when in practice we beat them in the vast majority of all cases. On Vegas the advantage is more clear, especially if you take the time to tune TRM properly. This reports aim to explain why and how we can derive proper hash rate values for fair comparisons between miners, and provide the tools necessary for any casual miner to verify our claims themselves instead of just taking our word for it.

At the end of the day, miner hash rate as tested by this tool is most probably the best assessment of any ethash miner, open or closed source. It tests what you get paid for as a miner, nothing else.

## Testing Methodology

The tool implements a fake ethash pool that:
  - Tracks poolside hash rate, reported hash rate and stale shares.
  - Displays the current bounds for the poolside hash rate at 99% and 95% confidence levels.
  - Configurable static epoch.
  - Uses a configurable static difficulty, presumably much lower than normal pools.
  - Tracks mining as one huge session to obtain a single large sample set, no rolling windows.

## Mining as a Poisson Process
Mining is easily modeled as a Poisson Process (see [1] and [2]). Each found and reported share is an event, and we can derive the average time between these events from the miner hash rate and pool difficulty.

For the purpose of this tool, i.e. verifying the true hash rate of a black box miner, the most important question is the following:

***How many shares do you need to produce a trustworthy estimate of a black box miner's true hash rate?***

The proven bounds we rely on in this tool is Theorem 1, result (3) from [3]:

Pr[ |X − λ| ≥ x ] ≤ 2e<sup>−x<sup>2</sup> / (2(λ+x) )</sup>, x > 0

In other words, for some specific period of mining we are expected to get λ shares. In reality, we get X shares. Using the equation above, we can derive probabilities for different confidence levels that X will be +-E% from our expected value λ. These are the derived bounds at 99% and 95% confidence levels:

| λ       | +-E% at 95% | +-E% at 99% |
|--:|--:|-:|
|     100 |   31.10% |  38.28%  |
|       500     | 12.91% |      15.66% |
|     1,000     | 8.97%  | 10.84%  |
|    10,000     | 2.75%  | 3.31%   |
|    50,000     | 1.22%  | 1.47%   |
|   100,000     | 0.86%  | 1.03%   |
|   200,000     | 0.61%  | 0.73%   |
|   500,000     | 0.38%  | 0.46%   |
|   750,000     | 0.31%  | 0.38%   |
| 1,000,000     | 0.27%  | 0.33%   |
| 5,000,000     | 0.14%  | 0.12%   |
| 10,000,000     | 0.10%  | 0.09%   |

Looking at the table above, this is what many miners find confusing:  **the only important metric is the number of shares found. How long time it takes to find those shares is irrelevant.**  A 1h mining session with 200 shares is better than a 7 days session with 150 shares. A 1h mining session on 10 rigs is better than 5 rigs. A 1h mining session with lower pool difficulty is better than higher difficulty. In the end, we only need a big set of shares and know how long it took to find them. This is a good thing though. It means that we can scale this problem by lowering the pool difficulty and obtain the same number of shares in a much shorter period of time, and we're still sampling the same underlying miner hash rate.

From the table we also realize we can never really _prove_ a miner's exact hash rate by just observing the number of shares it finds. The only thing we can state is e.g. that "*after 500,000 shares, we can prove that the observed poolside hash rate is within +-0.46% of the true miner hash rate in 99% of all cases*". In short, the amount of shares you need to produce a tight estimate of the true miner hash rate with a high confidence level is **massive**. To reason about +-0.4% hash rate discrepancies, we recommend at least 750k shares.

To put this into perspective: using a 6x580 rig doing 186 MH/s mining on a pool with a standard 4Gh difficulty, 750k shares will take 6 MONTHS(!) to find. Hence, when miners report their "24h poolside test" for a single rig, the statistical significance is close to zero in comparison to what we really need. Tests must also run uninterrupted in single sessions to not skew the results. In short, we must control and lock down as many aspects of the surrounding environment as possible. That is precisely what this tool helps you with.

## Running Tests
### Hosting
You can run the tool on the same machine running the miner, another machine in your private LAN, or use a cloud server with a real public IP. For simplicity and network stability, running on the same machine as the miner is recommended, and that's what we will outline in this guide. However, we still rely on a working public internet connection for Phoenix and TeamRedMiner for their dev fee connections. Without public internet, runs for those miners will not be valid.

Note that when testing Ethminer, TeamRedMiner and Phoenix miner they can all mine against the local network interface. Claymore however does not accept pools in a private IP space, most probably interpreting it as an attempt to circumvent the dev fee using a local proxy. Therefore, we need to apply a few small hacks, of which the Linux variant is trivial. The Windows approach we suggest is a bit more complex but not too bad.

##### Linux
From a terminal, run these two commands as root to redirect the public IP 99.99.99.99 to the local machine. For using a different machine on your private LAN, replace 127.0.0.1 with that machine's IP address.
```
$ iptables -t nat -A OUTPUT -d 99.99.99.99 -j DNAT --to-destination 127.0.0.1
$ echo 1 >/proc/sys/net/ipv4/ip_forward
```

##### Windows

** UPDATE: THIS SOLUTION DOES NOT WORK. FOR NOW, WHEN TESTING CLAYMORE ON WIN YOU MUST USE A CLOUD VM RUNNING THE TESTER. THE LINUX APPROACH WORKS FINE. **

The goal is to install the legacy Microsoft Loopback adapter and assign it the public IP 99.99.99.99. With this approach, you _must_ run the miner(s) and tester on the same machine:

 1. Open Device Manager. Select your computer's name and click the "Action" menu item. Select "Add legacy hardware".
 2. Click "Next", choose "Install the hardware that I manually...", click "Next".
 3. Choose "Network adapters", click "Next".
 4. Choose "Microsoft" and "Microsoft KM-TEST Loopback Adapter", click "Next", click "Next", click "Finish".
 5. Close Device Manager.
 6. Press win+R to run a command, run "ncpa.cpl".
 7. You should now have a Loopback Adapter among your network adapter. Right-click it, select "Properties".
 8. Select "Internet Protocol Version 4 (TCP/IPv4)", click Properties.
 9. Choose "Use the following IP address", and enter:
        IP address: 99.99.99.99
        Subnet mask: 255.255.255.0
        Default gateway: 99.99.99.1
        Preferred DNS server: 8.8.8.8
 10. Click "OK", "Close", close the Network connections window.
 11. As a test, open a command prompt and type "ping 99.99.99.99". You should now see a few pings with response time <1ms.


### Preparation
 
 On the machine running the tester (and also running the miner(s) when following this guide):
 
 1. If you're tech savvy, you might have node.js and npm installed already and know you're way around Node projects. If so, just clone this repo, run "npm install".
 2. For everyone else: download the most recent release for your OS from https://github.com/Kerney666/trm-ethash-miner-tester/releases.
 3. Unpack the release to some directory of your choice.
 4. Test running the tool with "trm_ethash_miner_tester.exe" or "./trm_ethash_miner_tester" from a Windows command prompt or Linux terminal. You should see a short help section printed.

### Running a test
Running a test means starting the test pool, then pointing a **single miner** at the pool. We test using a single rig / worker only, and we can only test one single miner software at the time per pool instance. You can run multiple test pool instances using different ports if you want to run multiple miners using e.g. a single gpu each simultaneously on the same machine.

**Please note: you will be mining air for the full duration of a test.**

Unless you are running multiple tests and really want to make sure you're repeating the test under the exact same conditions, you should use a DAG epoch that matches ETH or ETC. The easiest way to check the current epochs is here: [https://investoon.com/tools/dag_size](https://investoon.com/tools/dag_size). The tool has support for fetching the current epoch for ETH and ETC automatically.

The tester takes the following command line arguments in order:

 1. Port: the local port the test pool will listen on.
 2. Epoch: pass "ETH", "ETC" or an epoch nr. It's best to run with the true current epoch for the coin you appear to mine since Phoenix and TRM otherwise will rebuild the DAG during dev fee switches, increasing the dev fee period somewhat.
 3. MH/s: the total nr of MH/s you will point to the pool instance. This value is only used together with next arg (Shares/sec) to derive the pool difficulty. It doesn't have to be perfect accuracy, +-5% is fine.
 4. Shares/sec: the nr of shares/sec the miner should find (on average). Different miners tolerate different values here. The higher the value, the quicker the hash rate will converge. See the section per miner below.
 5. Secs between jobs: the nr of seconds between each new job sent out by the pool. Is only relevant for testing stale share rate, and therefore not applicable here. We typically use 20 secs.
 6. Reset after N hash rate reports: we do not want to base our average reported hash rate from the miner on reports sent during tuning or before it has converged properly at startup. Therefore, after the first N reports, we reset the reported hash rate. N should be high enough to cover any tuning the miner may do and also high enough for the miner to report a converged value. We set the nr to represent 15 mins for all miners in this guide.
 7. Verify shares 1/0: if set to 1, the tester will run Javascript ethash code and verify all shares. This is not necessary right now, all miners truthfully verifies their shares before sending them to the pool. This could change in the future though, and if you really want to make sure each share is valid (and you have a beefy cpu), feel free to set this to 1. A warning though: the verification code is slow and might skew your results. If you enable this option, you should make sure the submit response times as listed by the miner do not grow excessively. It is not recommended at this point.
 8. Reset stats on first share 1/0: if set to 1, the tester will reset the start time and discard the first received share. This means we don't include the initial DAG build time when calculating hash rates and the hash rate will converge more quickly. However, it also means that the poolside hash rate as displayed by e.g. TeamRedMiner will not match the value calculated by the tester. We still recommend going with 1 for this option.

It's recommended to keep log files for both the miner and the tester. TRM needs a specific option to enable logging to file that we include in the examples below. Claymore and Phoenix log to file by default. The tester tool will create log files named "miner_test.\<unix ms\>.log" for each run. Ethminer needs to have output redirected.

**NOTE:** In all examples, we only provide the binary name for an executable. Windows users might need to add ".exe" and Linux users need to prepend "./".

 **NOTE:**  the point of these tests is **not** to maximize or compare miners' absolute hash rates. You should rather keep all gpus at comfortable levels to avoid crashes and to be able to reproduce a test many times over. This might mean using different clocks per miner, which is fine. We're only interested in measuring the potential discrepancy between reported and produced hash rates, not how much we can push the gpus involved. We also don't have to care that much if one miner outperforms another. That is a separate test once we've established whether the displayed hash rate is accurate and truthful or not.

### Interpreting Results
The tester will continuously output info about shares, and the current estimate of hash rates every 10 secs. The hash rate information is the interesting part for us. This is an example of a 6h TeamRedMiner test with an aggressive nr shares/sec produced running on three Vegas, which means a dev fee of -1%. The hash rate has converged to the expected value after 1.67 million shares (and, it's mostly luck that it's so close to the target):
```
Hashrates for 1 active connections:
Global hashrate: 146.63 MH/s vs 148.11 MH/s avg reported [diff -1.01%] (A1670641:S3230:R0 shares, 22041 secs)
Global stats: 99.81% acc, 0.19% stale, 0% rej.
Global approx: [-1.26%, -0.76%] at 99% confidence, [-1.22%, -0.8%] at 95% confidence.
[1] hashrate:  146.63 MH/s vs 148.11 MH/s avg reported [diff -1.01%] (A1670641:S3230:R0 shares, 22041 secs)
```
In the output above, the "Global" lines are the most important ones. They represent the sum of all connections that have been made to the pool since start.

The first line presents the derived poolside hash rate (146.63 MH/s), the average of the reported hash rates (148.11 MH/s), the difference between the two (-1.01% in this case), and last the nr of A(ccepted), S(tale) and R(ejected) shares.

The second line presents statistics for all received shares.

The third line is the **most important line for this test**: using proven bounds for a Poisson distribution as per [3], it presents an interval around the current difference between the poolside and avg reported hash rates at 99% and 95% confidence levels. This means that in this specific case, we know that the true poolside hash rate the miner will generate over time is somewhere between -1.26% and -0.76% in 99% of all runs. For a somewhat lower confidence level, we can say that the true poolside hash rate is somewhere between -1.22% and -0.8%. This means that TeamRedMiner is well within the expected bounds after 1.67 million shares.


### Testing TeamRedMiner
TeamRedMiner can handle a high load of shares/sec. For best results, choose a DAG epoch matching that of ETH or ETC since this will give you a smooth dev fee mining in parallel with user mining without interruptions. If you use a different DAG epoch the hash rate will converge, the drop quickly, then converge, back and forth until you've ran for a sufficiently long time to smooth things out. As long as your cpu can handle the verification and you run with the correct ETH or ETC epoch, you can increase the value to 2-3 shares/sec/GPU. Please make sure your cpu load isn't too high when running, or results will be severely distorted.

#### Running Test
Step 1: start tester (replace MH/S with your worker's hash rate and calc 2.5*NrGPUs)
```
trm_ethash_miner_tester 12345 ETH <MH/S> <2.5*NrGPUs> 20 30 0 1
```
Step 2: start miner
```
teamredminer -a ethash -o stratum+tcp://localhost:12345 -u foo -p x --eth_stratum_mode=ethproxy --log_file=trm_test.log
```
#### Test Runtime
For a 6 GPU rig, doing 15 shares/sec running with the ETH or ETC epoch, 18-19h is enough runtime to generate > 1 million shares, more than enough for our purposes here.

#### Parsing Results
TeamRedMiner runs dev fee mining on a separate connection. This means that the global hash rate diff should converge to the dev fee: -1.00% for Vegas and -0.75% for Polaris rigs as long as you run the same DAG epoch as ETH or ETC, otherwise you might see a slightly higher value due to DAG rebuild times.

### Testing Phoenix Miner
Phoenix miner is not the best miner in terms of handling a high load of shares/sec, the displayed hash rate and miner behavior in general is affected if we lower the pool difficulty too much. Therefore, we recommend using conservative settings to not risk the quality of a test. Use a rig with at least 6 GPUs, then set the shares/sec variable to the nr of gpus, so 6 for a 6 GPU rig. Like for TeamRedMiner, choose a DAG epoch matching that of ETH or ETC and tell the miner which coin you are mining to avoid DAG rebuilds.

#### Running Test
Step 1: start tester (replace MH/S with your worker's hash rate and set NrGPUs)
```
trm_ethash_miner_tester 12345 ETH <MH/S> <NrGPUs> 20 45 0 1
```
Step 2: start miner
```
PhoenixMiner -coin eth -pool tcp://localhost:12345 -wal foo
```
#### Test Runtime
Per our recommendations, a 6 or 8 gpu rig is necessary for testing Phoenix to avoid too long runtimes. For a 8 GPU rig, you will generate around 1 million shares in ~35h, which is the recommended runtime.

#### Parsing Results
Phoenix Miner runs the dev fee mining on a separate connection. This means that the global hash rate diff always should converge to -0.65%, i.e. their listed dev fee, as long as you avoid DAG rebuilds during dev fee switches. You will be able to see the dev fee switches in the miner test logs, search for lines containing "dev fee" in the tester log.

### Testing Claymore

** UPDATE: THE NETWORK HACK DOES NOT WORK ON WIN. FOR NOW, WHEN TESTING CLAYMORE ON WIN YOU MUST USE A CLOUD VM RUNNING THE TESTER. THE LINUX APPROACH WORKS FINE. **

Claymore **must** have the network set up with a public IP address mapped back to your local workstation on Linux. On Windows, you need to run the tester on a real public IP, preferably a cloud VM. See the "Hosting" section above. Claymore can handle more shares/sec than Phoenix without distorting results, we use 1.5 x NrGPUs here.

Note that Claymore needs a proper Ethereum wallet address to mine at the same "pool" and hence avoid DAG rebuilds during dev fee switches. The wallet below is a generated wallet with unknown private key.

#### Running Test
Step 1: start tester (replace MH/S with your worker's hash rate and calc 1.5*NrGPUs)
```
trm_ethash_miner_tester 12345 ETH <MH/S> <1.5*NrGPUs> 20 45 0 1
```
Step 2: start miner (possibly with the public IP replaced if you run a cloud VM):
```
ethdcrminer64 -epool 99.99.99.99:12345 -ewal 0x5BAb3a21F783Ff0e45e0FaA320b477C79B2d06C4 -epsw x
```
#### Test Runtime
For a 6 GPU rig doing 1.5*6 = 9 shares/sec, we need ~31h for a complete run.

#### Parsing Results
Claymore runs dev fee mining on the user's pool when the wallet is a proper Ethereum-format wallet. This means that our tester sees all hashrate, and the expected converging value is actually 0.00%. A side-effect is also that the "[1]" numbers will represent the user's hashrate, i.e. the difference between the global data and "[1]" will be exactly -1.0%, which is Claymore's dev fee, it's usually spot on target.

### Testing Ethminer
Ethminer isn't the most power lean miner, but it does run a pretty competitive kernel from zawawa's Gateless Gate. The one thing ethminer has going for it is that it's open source and is very accurate with its hashrate calculations. This makes it a superb tool for the community to verify that _this tester_ is actually doing what it should as well and also show that when there is no dev fee switching or other complexity added, miners just don't have any problems at all converging to their expected value.

In our tests, we used the latest 0.19 alpha release from [https://github.com/ethereum-mining/ethminer/releases](https://github.com/ethereum-mining/ethminer/releases).

Ethminer can handle a decently high nr shares/sec/gpu setting. It might lose a little bit of raw hashrate, but all calculations are still 100% correct. Doing 1.5/sec/gpu is not a problem, and probably much more as well, but we want to keep things somewhat conservative.

#### Running Test
Step 1: start tester (replace MH/S with your worker's hash rate and calc 1.5*NrGPUs)
```
trm_ethash_miner_tester 12345 ETH <MH/S> <1.5*NrGPUs> 20 45 0 1
```
Step 2: start miner:
```
ethminer -G -P stratum1+tcp://99.99.99.99:2000 -v 6 -R --stdout
```
#### Test Runtime
For a 6 GPU rig doing 1.5*6 = 9 shares/sec, we need ~31h for a complete run for 1 million shares.

#### Parsing Results
Hashrate diff should converge to 0.00%, it's that simple, although anywhere in the 99% confidence interval is fine.

## Results
The whole point releasing this is for the community to _not_ have to trust our numbers. That said, below we are posting the results from our own runs. As 3rd parties post their numbers, we will replace our data here with results and links to confirmed runs outside of our control.

The interesting column is the 99% deviation interval. It's the 99% interval as reported by the tester but adjusted with the expected value to be able to compare miners.

Phoenix exhibited more crashes for us than the other miners, and we also tested at lower shares/sec numbers, hence the reason for presenting an additional shorter run. The sum of these three results provide a picture equivalent to a single long runs for the other three miners. That said, we'd rather populate this table with community results than our own.

| Miner |  Rig, Source | Hashrate (reported) | Hashrate (produced) |Shares, Runtime (secs)  | Expected | Result | Tester 99% interval | 99% deviation interval |
|--------|-------|--:|--:|-----:|---------:|------------:|--------:|--:|
|Ethminer 0.19a| 8x588, Linux (TRM devs) | 230.99 MH/s| 230.97 MH/s | 908,252, 85023s | 0.00% | -0.01% | [-0.35%, +0.33%] |  [-0.35%, +0.33%] | 
|Ethminer 0.19a| 8x478, Linux (TRM devs) | 256.78 MH/s| 256.59 MH/s | 1,483,228, 150295s | 0.00% | -0.08% | [-0.34%, 0.19%] |  [-0.34%, 0.19%] | 
|TRM 0.6.0| 8x478, Linux (TRM devs) | 260.24 MH/s | 258.19 MH/s | 3,061,749, 61812s |  -0.75% | -0.79% | [-0.97%, -0.60%] | [-0.23%, 0.15%]
|Claymore 14.7| 8x588, Linux (TRM devs) | 233.43 MH/s | 229.65 MH/s | 937,355, 88356s | 0.00% | -1.62% | [-1.96%, -1.28%] | [-1.96%, -1.28%] | 
|Claymore 15.0| 8x478, Linux (TRM devs) | 258.83 MH/s | 254.71 MH/s | 683,938, 115559s | 0.00% | -1.59% |  [-1.98%, -1.20%] | [-1.98%, -1.20%]
|Phoenix 4.7c| 8x578, Linux (TRM devs) | 268.69 MH/s | 260.96 MH/s | 502,342, 82823s | -0.65% | -2.88% | [-3.34%, -2.42%] | [-2.69%, -1.77%]
|Phoenix 4.7c| 8x588, Linux (TRM devs) | 235.43 MH/s | 228.50 MH/s | 247,327, 93572s | -0.65% | -2.95% | [-3.61%, -2.29%] | [-2.96%, -1.64%]
|Phoenix 4.7c| 4x574, Linux (TRM devs) | 122.82 MH/s | 119.16 MH/s | 212,751, 76995s | -0.65% | -2.98% | [-3.69%, -2.27%] | [-3.04%, -1.62%]
|Phoenix 4.8c| 8x478, Linux (TRM devs) | 261.89 MH/s | 254.38 MH/s | 1,016,375, 173138s | -0.65% | -2.87% | [-3.18%, -2.55%] | [-2.53%, -1.90%]

## FAQ
If necessary, this section will be filled with answers to frequent questions.

## References
[1] [https://towardsdatascience.com/the-poisson-distribution-and-poisson-process-explained-4e2cb17d459](https://towardsdatascience.com/the-poisson-distribution-and-poisson-process-explained-4e2cb17d459)

[2] [https://en.wikipedia.org/wiki/Poisson_point_process](https://en.wikipedia.org/wiki/Poisson_point_process)

[3] http://www.cs.columbia.edu/~ccanonne/files/misc/2017-poissonconcentration.pdf
