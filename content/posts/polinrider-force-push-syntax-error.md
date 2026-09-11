---
title: "Incident Report: a Second PolinRider Attempt — Caught by the Attacker's Own Bug"
date: 2026-08-22
draft: false
tags: [incident-response, supply-chain, malware, lazarus-group, dprk, git, github, vercel, threat-intel]
---

{{< note >}}
Follow-up to [Incident Report: PolinRider — a Blockchain Dead-Drop
Supply-Chain Compromise]({{< relref "polinrider-blockchain-dead-drop-supply-chain-compromise.md" >}}),
same client, same underlying compromised developer account. As with that
post, all client identity, employee names, GitHub handles, and repository
names are **redacted or replaced with generic placeholders**. If you haven't
read the first post, read the "Background" section there first — it
explains what PolinRider is and how the force-push impersonation trick
works; this post assumes that context.
{{< /note >}}

## |=---[ TL;DR ]

Four months after the first incident, the same still-compromised developer
account force-pushed the same PolinRider malware family into a different
client repository — three malicious commits across three branches, in a
single burst. This time, **the attacker's own payload had a JavaScript
syntax error** in it, so every single build attempt failed before any
malicious code could run. Production was never touched. Cleanup took under
a day.

```text
Date:        August 21–22, 2026
Attacker:    same compromised account as IR-2026-001 (never remediated)
Vector:      same developer workstation/account, still infected
Impact:      0 of 3 malicious builds executed (syntax error); production
             clean throughout
Status:      Closed
```

## |=---[ What happened ]

At 06:10 UTC, three commits were force-pushed in quick succession from the
same compromised developer account identified in the earlier incident,
across three different branches of a different client project:

```text
branch A (the developer's own branch): 686c5dc -> 8ba6a1f
branch main:                           97a6fdd -> d81663a
branch B (an unrelated feature branch): 6cdedbc -> 1c37e91
```

Every one of the three commits injected the same obfuscated payload into a
build config file (`postcss.config.mjs` this time, instead of the Tailwind
config file from the first incident — same campaign, different target
file, see the IOC list in the first post).

The deploy platform (Vercel) attempted to build all three:

- The `main` and feature-branch builds **failed after ~21 seconds** with a
  JavaScript syntax error.
- The build on the developer's own branch never even started — it was
  auto-blocked by a "non-team-member deployment protection" rule, because
  that GitHub account had since lost write access after the previous
  incident's account cleanup (it was re-added as a collaborator on this
  *different* repo, which is how it could push here at all).

No malicious code executed anywhere. The repo owner noticed the failed
checks the same day, reviewed the diff, and removed the payload.

## |=---[ The bug that saved them ]

This is worth looking at directly, because it's a good example of how
fragile obfuscated malware can be — one bad find-and-replace during whatever
templating step produced this payload build, and the whole delivery
mechanism DOAs.

The injected code loads several Node.js built-ins through a `createRequire`
call assigned to an identifier — and then, inside the payload it appended,
declares an identifier with that exact same name again in the same scope:

```js
// (illustrative reconstruction of the shape of the bug — the real
// payload is minified/obfuscated, this is the equivalent unobfuscated form)

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);   // first declaration

// ... 380-ish characters of whitespace padding ...

const require = ... ;   // <- SyntaxError: Identifier 'require' has already
                         //    been declared in this scope
```

Node's build tooling reported it plainly:

```text
the name 'require' is defined multiple times
```

`export default config;` — the file's real, legitimate content — sat right
below the injected block, completely untouched. The attacker's tooling
appended the payload *after* the legitimate export rather than merging it
in, and in doing so declared the same binding twice. Because JavaScript
treats a duplicate `const`/`let` in the same scope as a parse-time error,
not a runtime one, the file never got far enough to execute *anything* —
not the legitimate config, not the malicious payload.

## |=---[ Why this matters despite "nothing happened" ]

It's tempting to read "the payload was broken, so it's a non-event." Three
reasons that's the wrong takeaway:

1. **The attacker will fix the bug.** This is the same automated campaign
   from the first incident, redeployed against a second project. The next
   attempt — or the next victim — may not get a free pass from a typo.
2. **The access that enabled this was never closed.** The force push came
   from the *same account* compromised in April. Four months later, it
   still had write access to a project and could still push. A syntax
   error is not a control; it's luck.
3. **Attribution forgery was present again**, same trick as the first
   incident: one of the three malicious commits was crafted to look like a
   normal merge of an already-open, legitimate pull request — same parent
   commits, same author name and date as the real merge commit it
   replaced — but with a committer identity and timestamp offset that
   didn't match anything else in the repository's history. Diffing the
   forged commit against both of its parents showed both parents were
   clean; a three-way merge of two clean sides cannot legitimately produce
   a modified result, which is what exposed it as hand-crafted rather than
   an actual merge.

## |=---[ Remediation ]

All of the following was completed the same day the failed builds were
noticed:

1. Reviewed the git history of the targeted file across every branch to
   identify all injected commits and confirm the state of their parents.
2. Confirmed the authentic pre-attack commit was still reachable from an
   unaffected branch.
3. Reset the local `main` branch back to that clean commit.
4. Force-pushed the corrected branch with `git push --force-with-lease`,
   replacing the forged commit on the remote.

   {{< note >}}
   `--force-with-lease` instead of a plain `--force`: it refuses to push if
   the remote branch has moved since you last fetched it, which prevents
   *your own* cleanup force-push from accidentally clobbering someone
   else's legitimate work landed in the meantime. Good habit for any
   force push, not just incident cleanup.
   {{< /note >}}
5. Deleted both malicious branches from the remote entirely.
6. Removed the compromised account from the repository's collaborator list.
7. Verified the restored file byte-for-byte against the known-clean version
   and confirmed the commit's committer field matched GitHub's own
   merge-bot identity again (the tell for an authentic, non-forged merge
   commit).
8. Confirmed via `git ls-remote` that neither malicious branch remained.
9. Pushed one content-neutral commit afterward to confirm the deploy
   pipeline still worked cleanly end to end.

## |=---[ Takeaways ]

- **Closing an incident on one repository doesn't close it everywhere the
  compromised account has access.** The first incident's remediation
  focused on the affected project; this account still had a foothold
  elsewhere. Whenever a developer account or workstation is confirmed
  compromised, audit and revoke its access across *every* repository and
  organization it touches, not just the one that got hit.
- **"The exploit didn't fire" is not the same as "we're safe."** Treat a
  failed malicious build exactly like a successful one for response
  purposes — full review, full IOC sweep, full access audit — because the
  only thing that failed was the attacker's code, not their access.
- **Branch protection would have stopped this at the door, same as the
  first incident.** Both incidents share one root enabler: force pushes
  were possible on `main`. That's the fix that generalizes across both
  write-ups.
- Malware is software, and software has bugs. Don't rely on that — rely on
  access control — but it's a useful reminder that "sophisticated,
  nation-state-attributed" does not mean "bug-free."

## |=---[ References ]

See the [first incident write-up]({{< relref "polinrider-blockchain-dead-drop-supply-chain-compromise.md" >}})
for background on PolinRider, the malware's obfuscation layers, its
blockchain dead-drop C2 mechanism, and full attribution sources.
