---
title: "Why Your Linux Kernel Starts With 'MZ' (Yes, the DOS/PE One)"
date: 2026-09-11
draft: false
tags: [linux, kernel, uefi, efi, pe-coff, boot, x86, low-level, reverse-engineering]
---

{{< note >}}
Every command and hex dump in this post was run live on this machine
(`uname -r`: 7.2.4-arch1-2) against its real `/boot/vmlinuz-linux`. Nothing
here is a mockup — you can reproduce every byte on your own box.
{{< /note >}}

## |=---[ TL;DR ]

Your Linux kernel image (`/boot/vmlinuz-*`) starts with the two bytes
`4D 5A` — `"MZ"` — the ancient MS-DOS executable magic number, followed a
little further in by a real `"PE\0\0"` (COFF) header with
`Subsystem = IMAGE_SUBSYSTEM_EFI_APPLICATION`. This is not a coincidence, a
joke, or legacy cruft nobody bothered to remove. It's **required by the
UEFI specification**: UEFI firmware only knows how to load and execute
PE32+ binaries. To let a UEFI system boot Linux with zero extra
bootloader code, the kernel's boot header was made to **also be a
valid PE/COFF executable** — while *simultaneously* remaining a valid
legacy BIOS boot sector for machines that don't have UEFI at all. Same
bytes, two boot protocols.

```text
$ file /boot/vmlinuz-linux
/boot/vmlinuz-linux: Linux kernel x86 boot executable, bzImage, ...
32-bit EFI handoff entry point, 64-bit EFI handoff entry point, ...

$ xxd -l 4 /boot/vmlinuz-linux
00000000: 4d5a 0000                                MZ..
```

## |=---[ Background: two executable formats, two boot worlds ]

A few things this post leans on, from scratch:

- **MZ / PE**: `MZ` is the magic number of the old MS-DOS executable
  format (`.EXE`), named after Mark Zbikowski, one of its authors at
  Microsoft. Windows NT's executable format, **PE** (Portable
  Executable, `.exe`/`.dll`/`.efi`/`.sys`), is backward-compatible with it
  on purpose: a PE file *starts* with a real MS-DOS header (so old DOS
  would print "This program cannot be run in DOS mode" instead of
  crashing), and at a fixed offset — byte `0x3C` — that DOS header stores
  a 4-byte pointer called `e_lfanew`, pointing forward to where the real
  `PE\0\0` header begins. Everything between the DOS header and the PE
  header is technically a tiny, real, runnable DOS program (the "DOS
  stub").
- **UEFI**: the modern replacement for BIOS. Critically for this post,
  **the UEFI spec defines its executables as PE32+ (PE32 for 64-bit
  address space) images** — UEFI firmware, at its core, is a minimal
  PE-loader. Anything you want firmware to `LoadImage()`/`StartImage()`
  directly — a bootloader, a driver, a recovery tool — has to be a valid
  PE/COFF binary with `Subsystem = IMAGE_SUBSYSTEM_EFI_APPLICATION`.
- **The old BIOS way**: BIOS doesn't know or care about executable
  formats. It just loads the first 512-byte sector of a disk into memory
  and jumps to it, provided that sector ends with the magic bytes `55 AA`
  at offset `0x1FE`. Whatever's in those 512 bytes is 100% up to you.

So: two completely different firmware interfaces, two completely
different expectations about what a "bootable file" looks like. The
Linux kernel image has to satisfy both, because it's built once and
needs to boot on both old BIOS machines and modern UEFI ones (directly,
or via GRUB/systemd-boot, which themselves are PE binaries for the same
reason).

## |=---[ Hands-on: reading the header byte by byte ]

Let's actually parse `vmlinuz` by hand, no tools beyond `xxd`.

**Byte 0 — the DOS magic:**

```text
$ xxd -l 64 /boot/vmlinuz-linux
00000000: 4d5a 0000 0000 0000 0000 0000 0000 0000  MZ..............
00000010: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000020: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000030: 0000 0000 0000 0000 cd23 8281 4000 0000  .........#..@...
```

`4d 5a` = `"MZ"`. This is `IMAGE_DOS_SIGNATURE`. It has to be the very
first two bytes of the file for *any* PE-format tool (or UEFI firmware)
to even bother looking further.

**Byte 0x3C — the `e_lfanew` pointer:**

```text
$ xxd -s 0x3c -l 4 /boot/vmlinuz-linux
0000003c: 4000 0000                                @...
```

Little-endian `40 00 00 00` = `0x00000040`. This says: "the real PE
header starts at offset 0x40 in this file." Every PE parser — including
UEFI firmware's own loader — reads this field to jump straight past the
DOS stub.

**Following the pointer — the PE/COFF header:**

```text
$ xxd -s 0x40 -l 32 /boot/vmlinuz-linux
00000040: 5045 0000 6486 0400 0000 0000 0000 0000  PE..d...........
00000050: 0100 0000 a000 0602 0b02 0214 0090 0601  ................
```

Reading it field by field:

```text
offset 0x40:  50 45 00 00            "PE\0\0"   IMAGE_NT_SIGNATURE
offset 0x44:  64 86                  Machine    = 0x8664 (AMD64)
offset 0x46:  04 00                  NumberOfSections = 4
offset 0x48:  00 00 00 00            TimeDateStamp = 0 (reproducible build)
offset 0x54:  a0 00                  SizeOfOptionalHeader = 0x00A0
offset 0x56:  06 02                  Characteristics = EXECUTABLE_IMAGE | ...
offset 0x58:  0b 02                  OptionalHeader Magic = 0x020B (PE32+)
```

`0x020B` confirms this is a **PE32+** image — the 64-bit PE variant,
same format used by every native 64-bit Windows `.exe` and every 64-bit
UEFI driver.

**The field that actually tells firmware "boot me": `Subsystem`.**

In a PE32+ optional header, `Subsystem` sits 68 bytes after the `Magic`
field (`0x58 + 68 = 0x9C`):

```text
$ xxd -s 0x9c -l 4 /boot/vmlinuz-linux
0000009c: 0a00 0001                                ....
```

`0a 00` = `0x000A` = **10** = `IMAGE_SUBSYSTEM_EFI_APPLICATION`. This
single value is the whole point of the exercise: it's the field UEFI
firmware checks to decide "this is an EFI application, I know how to run
this," as opposed to `IMAGE_SUBSYSTEM_WINDOWS_CUI` (3, a normal Windows
console app) or `WINDOWS_GUI` (2). Change one byte here and firmware
would refuse to load a byte-for-byte identical kernel.

**The section table — proof it's a real, structured PE image, not a
faked-up 4 bytes of magic:**

```text
$ xxd -s 0xf8 -l 40 /boot/vmlinuz-linux
000000f8: 2e73 6574 7570 0000 0030 0000 0010 0000  .setup...0......
00000108: 0030 0000 0010 0000 0000 0000 0000 0000  .0..............
00000118: 0000 0000 4000 0042 2e63 6f6d 7061 7400  ....@..B.compat.
```

Right after the optional header comes a normal PE section table, 40
bytes per entry, each starting with an 8-byte ASCII name. This kernel
image declares (at least) four sections: **`.setup`**, **`.compat`**,
`.text`, `.data` — a real PE loader will map these in exactly like it
would for `notepad.exe`.

## |=---[ The other half: it's *also* a legacy BIOS boot sector ]

Here's the part that makes this genuinely clever rather than just "the
kernel happens to be a PE file." Jump to offset `0x1FE`, the one place
in a file that matters to old-school BIOS booting:

```text
$ xxd -s 0x1fe -l 16 /boot/vmlinuz-linux
000001fe: 55aa eb6a 4864 7253 0f02 0000 0000 0010  U..jHdrS........
```

`55 aa` — the mandatory **BIOS boot-sector signature**, at exactly the
offset BIOS requires it. Right after it: `48 64 72 53` = `"HdrS"`, the
magic of the Linux kernel's own `setup_header` structure (parsed by
real-mode bootloaders like GRUB's legacy BIOS path, or even the kernel's
own built-in real-mode setup code). This is a **completely different,
older, BIOS-era boot protocol**, living in the exact same bytes as the
PE header above it.

To see why this matters, compare against a *pure* EFI application on
the same disk — GRUB's own `grubx64.efi`, which has no reason to ever be
BIOS-bootable:

```text
$ xxd -s 0x1fe -l 16 /boot/EFI/GRUB/grubx64.efi
000001fe: 00c0 2e72 656c 6f63 0000 0020 0000 0050  ...reloc... ...P

$ file /boot/EFI/GRUB/grubx64.efi
/boot/EFI/GRUB/grubx64.efi: PE32+ executable for EFI (application),
x86-64 (stripped to external PDB), 4 sections
```

No `55 AA` at `0x1FE` — because GRUB's `.efi` binary doesn't need one, it
is *only* ever loaded by UEFI firmware, never by a BIOS jumping to a
disk sector. `vmlinuz`, on the other hand, deliberately keeps both
markers valid at once:

| Offset | Bytes | Meaning | Consumed by |
|---|---|---|---|
| `0x000` | `4D 5A` | `"MZ"` / `e_lfanew` @ `0x3C` | Any PE loader, incl. UEFI |
| `0x040` | `50 45 00 00` | `"PE\0\0"` header, `Subsystem=EFI_APPLICATION` | UEFI firmware |
| `0x1FE` | `55 AA` | BIOS boot-sector signature | Legacy BIOS / GRUB legacy |
| `0x202` | `48 64 72 53` | `"HdrS"`, Linux `setup_header` | BIOS-era Linux bootloaders |

One 17 MB file. Two mutually exclusive, decades-apart boot protocols,
both satisfied simultaneously, because the byte ranges each protocol
actually *reads* don't overlap.

## |=---[ Why: this is called the EFI stub, and it's in the kernel source ]

This mechanism has a name: the **EFI boot stub** (`CONFIG_EFI_STUB`). It
was added to `arch/x86/boot/header.S` by Matt Fleming, first posted to
LKML in October 2011 ("x86, efi: EFI boot stub support"). The kernel's
own documentation describes the goal directly:

> On the x86 and arm platforms, a kernel zImage/bzImage is made to
> masquerade as a PE/COFF image, thereby convincing EFI firmware loaders
> to load it as an EFI executable.

Annotated, based on the real structure of `arch/x86/boot/header.S`:

```asm
	.code16
	.section ".bstext", "ax"
	.byte	0xeb		# short (2-byte) jump
	.byte	start_of_setup-1f
	# ^ written as raw bytes, not a `jmp` mnemonic — the assembler
	#   would otherwise emit a 3-byte jump and shift every fixed
	#   offset below it, breaking the boot-sector/PE layout

#ifdef CONFIG_EFI_STUB
	.org	0x3c
	.long	pe_header		# e_lfanew: offset to the real PE header
					# (this is the value we read above: 0x40)

	.word	IMAGE_DOS_SIGNATURE	# "MZ" — must be bytes 0-1 of the file

	...

pe_header:
	.long	IMAGE_NT_SIGNATURE	# "PE\0\0"

coff_header:
	.word	IMAGE_FILE_MACHINE_AMD64
	.word	section_count		# NumberOfSections
	...

optional_header:
	.word	PE_OPT_MAGIC_PE32PLUS	# 0x020B
	...
	.word	IMAGE_SUBSYSTEM_EFI_APPLICATION	# Subsystem = 10
	...
#endif /* CONFIG_EFI_STUB */
```

The whole thing is `#ifdef`'d in specifically because it's *only*
needed for EFI compatibility — a kernel built without
`CONFIG_EFI_STUB` skips all of it and keeps the classic BIOS-only boot
sector, no MZ/PE bytes at all.

The other side of the trick, `drivers/firmware/efi/libstub/x86-stub.c`,
is the actual code that runs *as* the EFI application: it's the real
`efi_main()` entry point UEFI firmware jumps to after `LoadImage()`
succeeds, which sets up the environment (memory map, initrd, command
line) and hands off to the kernel's normal decompression/startup path —
the same path a BIOS boot would eventually reach too. Both roads lead to
the same kernel; only the on-ramp differs.

{{< note >}}
This is also why you can boot a raw `vmlinuz` file **directly** from a
UEFI shell or a UEFI boot entry, no GRUB required — that's the entire
point of the EFI stub. `systemd-boot` and unified kernel images (UKIs)
lean on exactly this property.
{{< /note >}}

## |=---[ Reproduce it yourself ]

No special tools needed beyond `xxd`/`file`, which ship on essentially
every Linux box:

```bash
# 1. confirm the DOS/PE magic
xxd -l 4 /boot/vmlinuz-linux                 # expect: 4d 5a 00 00

# 2. follow e_lfanew to the PE header
off=$(xxd -s 0x3c -l 4 -e /boot/vmlinuz-linux | awk '{print $2}')
xxd -s "$((16#${off}))" -l 4 /boot/vmlinuz-linux   # expect: 50 45 00 00 ("PE\0\0")

# 3. read the Subsystem field (0x9c for a PE32+ boot header)
xxd -s 0x9c -l 2 /boot/vmlinuz-linux          # expect: 0a 00 -> 10 (EFI_APPLICATION)

# 4. confirm it's still a legacy-bootable BIOS sector too
xxd -s 0x1fe -l 2 /boot/vmlinuz-linux         # expect: 55 aa

# 5. let `file` do all of the above for you at once
file /boot/vmlinuz-linux
```

If you want a broader sweep, `grep`/`binwalk` for the magic across your
whole `/boot`:

```bash
$ for f in /boot/vmlinuz-* /boot/EFI/*/*.efi; do
    sig=$(xxd -l 2 -p "$f" 2>/dev/null)
    [ "$sig" = "4d5a" ] && echo "$f: MZ present"
  done
/boot/vmlinuz-linux: MZ present
/boot/EFI/GRUB/grubx64.efi: MZ present
```

Every UEFI-loadable file on the system starts the same way — the kernel
is just the one that's *also* something else at the same time.

## |=---[ Takeaways ]

- **`MZ` in `vmlinuz` isn't legacy junk — it's a spec requirement.** UEFI
  firmware is fundamentally a PE loader; anything meant to run under it
  has to look like a PE binary, full stop, including the kernel.
- **One file, two file formats, zero conflict**, because BIOS only ever
  reads byte `0x1FE` and PE loaders only ever follow the `e_lfanew`
  pointer from `0x3C` — the two protocols were designed decades apart
  and happen not to step on each other's bytes.
- **A single flipped bit can matter enormously.** `Subsystem = 10` is
  the entire difference between "firmware treats this as a bootable EFI
  application" and "firmware refuses to load it." Worth remembering
  next time a "cosmetic" header field looks safe to touch.
- If you ever need to identify or fingerprint boot files during
  forensics or malware triage: `MZ` + a *valid* `e_lfanew` pointing at a
  real `PE\0\0` is a much stronger signal than the two magic bytes
  alone — check where `e_lfanew` actually points before trusting the
  file type.

## |=---[ References ]

- Linux kernel docs — [The EFI Boot Stub](https://docs.kernel.org/admin-guide/efi-stub.html)
- Kernel source — [`arch/x86/boot/header.S`](https://github.com/torvalds/linux/blob/master/arch/x86/boot/header.S)
- Kernel source — [`arch/x86/boot/setup.ld`](https://github.com/torvalds/linux/blob/master/arch/x86/boot/setup.ld)
- LKML — Matt Fleming, [`[PATCH v5 10/10] x86, efi: EFI boot stub support`](https://lkml.org/lkml/2011/10/17/76), Oct 2011
- Microsoft — [PE Format specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format) (DOS header, `e_lfanew`, `IMAGE_SUBSYSTEM_*` values)
- UEFI Forum — [UEFI Specification](https://uefi.org/specifications), §2.1 "PE/COFF Image Loading"
