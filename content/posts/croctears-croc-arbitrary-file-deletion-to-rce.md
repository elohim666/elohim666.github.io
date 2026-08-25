---
title: "CrocTears: Arbitrary File Deletion to RCE in croc"
date: 2026-08-25
draft: false
tags: [croc, go, file-deletion, path-traversal, rce, cve]
---

## |=---[ Summary ]

A malicious **sender** can delete arbitrary files (and empty directories) on a
**receiver's** machine — anywhere the receiving user has permission — by sending
a file named `croc-marked-files.txt`.

croc uses that exact filename in the current working directory as its internal
"delete these temp files on exit" list, and deletes every path it contains
**without any validation**. Because a received file with that name lands in the
receiver's working directory (the default receive location), the incoming file
*becomes* the deletion list, and its contents are fully attacker-controlled.
Deletion runs automatically when the transfer completes, and also on Ctrl-C.

{{< note >}}
This research was conducted against software I control, reported to the
maintainer, and is published after the fix shipped. For authorized security
research and defensive use only.
{{< /note >}}

## |=---[ Affected / Fixed ]

- **Product:** croc
- **Vendor / author:** Zack Scholl (schollz)
- **Package:** `github.com/schollz/croc` (Go)
- **Affected versions:** `>= 10.0.13, <= 11.0.2`
- **Fixed in:** commit `c0d51f0` (PR #1232) — release
  [`11.0.3`](https://github.com/schollz/croc/releases/tag/v11.0.3)

## |=---[ Details ]

Two functions in `src/utils/utils.go` implement a cleanup mechanism for
temporary files:

- `const crocRemovalFile = "croc-marked-files.txt"` — a **fixed, relative** path
  resolved against the current working directory.
- `RemoveMarkedFiles()` opens that file and runs `os.Remove(line)` for **every
  line, with no path validation and no confinement to the working directory**,
  so absolute paths and `../` traversal are honored.

`RemoveMarkedFiles()` is invoked on **normal exit** (`main.go:45`) and on
**SIGINT/Ctrl-C** (`main.go:51`) after any receive.

The receiver writes incoming top-level files into the current working directory
(`FolderRemote = "./"`), and the name `croc-marked-files.txt` passes
`utils.ValidFileName` — it is an ordinary basename with no separators.

As a result, a sender who sends a file **named** `croc-marked-files.txt` whose
**contents** are a newline-separated list of victim paths causes those paths to
be deleted on the receiver when croc exits.

Relevant code:

- `src/utils/utils.go` — `crocRemovalFile`, `MarkFileForRemoval`, `RemoveMarkedFiles`
- `main.go:45` and `main.go:51` — cleanup invocation
- the receive path, which writes top-level files to the CWD

The paths are taken verbatim from attacker-controlled file content, so this is
**External Control of File Name or Path** used in a delete operation, combined
with **Path Traversal** (absolute / `../`).

## |=---[ PoC ]

Using a local relay — nothing leaves the machine. On UNIX the code phrase is
passed via `CROC_SECRET`.

**1. Attacker crafts and sends the payload:**

```bash
mkdir -p /tmp/attacker && cd /tmp/attacker
printf 'secret.txt\n../victim-sibling.txt\n/tmp/absolute-target.txt\n' > croc-marked-files.txt
croc send croc-marked-files.txt
```

**2. Victim receives into a directory containing valuable files:**

```bash
mkdir -p /tmp/victim && cd /tmp/victim
echo A > secret.txt                  # relative (CWD)
echo B > /tmp/victim-sibling.txt     # the ../ target
echo C > /tmp/absolute-target.txt    # absolute
CROC_SECRET=<SECRET> croc --yes
```

**3.** On completion, `secret.txt`, the `../` target, and the absolute-path
target are all deleted. The same occurs if the receiver presses Ctrl-C after the
file has arrived.

Verified: CWD-relative, `../` traversal (escapes the receive directory), and
absolute paths all delete. Deletion is attributable solely to the receiver.

## |=---[ Impact ]

A peer you are **receiving from** can delete arbitrary files and empty
directories owned by the receiving user — `~/.ssh/authorized_keys`, dotfiles,
documents, project files. It triggers on normal completion, silently with
`--yes`.

This far exceeds the expected "receive a file into this folder" trust boundary.

## |=---[ Escalation: Arbitrary File Deletion -> RCE ]

The same primitive — a sender fully controls the basename (dotfiles included)
and the content of files written into the receive directory — escalates to code
execution when the victim receives into their home directory.

**1. Bypass the overwrite prompt (using the deletion bug above).** Transfer 1
sends `croc-marked-files.txt` whose contents list the victim's existing
shell-init file, e.g. `.bashrc`. On exit, `RemoveMarkedFiles()` deletes it.

{{< img src="/img/croc-01-delete-bashrc.png" path="transfer-1/croc-marked-files.txt" caption="fig.1 — transfer 1 deletes the victim's ~/.bashrc on exit" >}}

**2. Plant a malicious init file.** Transfer 2 sends a file named `.bashrc`.
Because the original was deleted, no overwrite prompt fires.

{{< img src="/img/croc-02-plant-bashrc.png" path="transfer-2/.bashrc" caption="fig.2 — the malicious .bashrc lands with no overwrite prompt" >}}

**3. Delivery.** The victim runs `CROC_SECRET=<SECRET> croc … --yes` twice: the
first transfer (`croc-marked-files.txt`) deletes `~/.bashrc` on exit, and the
second writes the attacker's malicious `~/.bashrc` with no overwrite prompt.

{{< img src="/img/croc-03-delivery.png" path="victim/$HOME" caption="fig.3 — both transfers accepted silently under --yes" >}}

**4. Execution.** The attacker's code runs as the victim on the next shell or
login — for a server, on the next SSH login.

{{< img src="/img/croc-04-execution.png" path="victim/$HOME/.bashrc" caption="fig.4 — code execution as the victim on next login" >}}

{{< note >}}
The victim must run croc from $HOME so that its .bashrc is the one replaced —
received writes are confined to the working-directory subtree, but the delete
is not confined and accepts absolute and ../ paths. Two transfers must be
accepted: silent under --yes, otherwise the filenames appear in the accept
prompt.
{{< /note >}}

## |=---[ Vulnerability Classes ]

- **CWE-73:** External Control of File Name or Path — the sender controls the
  name and contents of the file used as the deletion list *(primary)*
- **CWE-22:** Improper Limitation of a Pathname to a Restricted Directory —
  the delete list honors `../` and absolute paths
- **CWE-94:** Improper Control of Generation of Code

**CVSS 3.1:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:H` — base score
**8.1 (High)**

## |=---[ Disclosure Timeline ]

```
Aug 10, 2026  02:07 GMT+2   reported to the maintainer via GitHub Security
                            Advisory and email
Aug 10, 2026  02:53 GMT+2   fix merged in PR #1232, without response from
                            the maintainer
later                       CVE requested from MITRE
```

## |=---[ References ]

- Fix (PR): <https://github.com/schollz/croc/pull/1232>
- Fix commit: <https://github.com/schollz/croc/commit/c0d51f095e3bf91c94208c4db8101c4e60219b03>
- Release: <https://github.com/schollz/croc/releases/tag/v11.0.3>

Discovered and reported by Anas SOUIRI ([@elohim666](https://github.com/elohim666)).
