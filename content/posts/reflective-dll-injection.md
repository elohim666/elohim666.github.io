---
title: "Reflective DLL Injection: A Practical Walkthrough"
date: 2026-08-25
draft: false
tags: [maldev, injection, windows]
---

## |=---[ Overview ]

Reflective DLL injection is a technique that allows a DLL to be loaded
from memory rather than from disk. Unlike standard DLL injection which
relies on `LoadLibrary` and a file path, the reflective approach maps
the DLL manually, resolving imports and relocations without ever
touching the filesystem.

The core idea: we write a minimal PE loader inside the DLL itself. When
the DLL is injected into a remote process, this loader bootstraps
execution by parsing its own headers in memory, applying relocations,
resolving imports via the PEB, and jumping to `DllMain`.

{{< note >}}
This post is for educational and authorized security research only.
{{< /note >}}

## |=---[ Setting Up ]

```bash
$ git clone https://github.com/example/reflective-dll-demo.git
$ cd reflective-dll-demo
$ mkdir build && cd build
$ cmake -G "Visual Studio 17 2022" -A x64 ..
$ cmake --build . --config Release
```

## |=---[ The Reflective Loader ]

The loader function is exported by the DLL and acts as a minimal PE
loader. It needs to find its own base address, parse PE headers to
map sections, and process the relocation table and import directory.

```c
// ReflectiveLoader.c
// Minimal reflective loader — bootstraps DLL from memory

#include <windows.h>

// Walk the PEB to find kernel32.dll base address
HMODULE GetKernel32(VOID) {
    PPEB pPeb = (PPEB)__readgsqword(0x60);
    PPEB_LDR_DATA pLdr = pPeb->Ldr;
    PLIST_ENTRY pHead = &pLdr->InMemoryOrderModuleList;
    PLIST_ENTRY pEntry = pHead->Flink;

    while (pEntry != pHead) {
        PLDR_DATA_TABLE_ENTRY pMod = CONTAINING_RECORD(
            pEntry, LDR_DATA_TABLE_ENTRY,
            InMemoryOrderLinks
        );

        if (HashModule(pMod->BaseDllName) == KERNEL32_HASH) {
            return (HMODULE)pMod->DllBase;
        }

        pEntry = pEntry->Flink;
    }

    return NULL;
}
```

### ## Resolving Imports

Once we have `kernel32.dll`, we resolve `GetProcAddress`
and `LoadLibraryA` by walking the export table manually.

```c
FARPROC FindExport(HMODULE hModule, DWORD dwHash) {
    PIMAGE_DOS_HEADER pDos = (PIMAGE_DOS_HEADER)hModule;
    PIMAGE_NT_HEADERS  pNt  = (PIMAGE_NT_HEADERS)(
        (ULONG_PTR)hModule + pDos->e_lfanew
    );

    PIMAGE_EXPORT_DIRECTORY pExport = (PIMAGE_EXPORT_DIRECTORY)(
        (ULONG_PTR)hModule +
        pNt->OptionalHeader.DataDirectory[0].VirtualAddress
    );

    PDWORD pdwNames = (PDWORD)((ULONG_PTR)hModule + pExport->AddressOfNames);
    PWORD  pwOrds   = (PWORD)((ULONG_PTR)hModule + pExport->AddressOfNameOrdinals);
    PDWORD pdwAddrs = (PDWORD)((ULONG_PTR)hModule + pExport->AddressOfFunctions);

    for (DWORD i = 0; i < pExport->NumberOfNames; i++) {
        LPCSTR szName = (LPCSTR)((ULONG_PTR)hModule + pdwNames[i]);
        if (HashString(szName) == dwHash) {
            return (FARPROC)((ULONG_PTR)hModule + pdwAddrs[pwOrds[i]]);
        }
    }

    return NULL;
}
```

## |=---[ The Injector ]

The injector reads the DLL from disk, allocates memory in the target,
writes the raw bytes, and creates a remote thread at the exported
`ReflectiveLoader`.

```bash
$ cl.exe /nologo /O2 /W4 injector.c /Fe:injector.exe
$ cl.exe /nologo /O2 /W4 /LD reflective_dll.c /Fe:payload.dll

# inject into notepad (PID 1234)
$ .\injector.exe 1234 .\payload.dll
```

## |=---[ Detection Notes ]

This technique leaves no DLL on disk and no entry in the PEB module
list. However, several detection surfaces exist:

- RWX memory regions flagged by EDR scanners
- `CreateRemoteThread` calls to suspicious targets
- Unbacked executable memory (no file on disk)
- ETW thread creation events

> The best injection is the one that never needs to inject. Consider
> DLL sideloading or COM hijacking before reaching for process injection.

## |=---[ Screenshots ]

Here's how you'd include a screenshot in a post:

{{< img src="/img/example.png" path="/tmp/screenshots/amsi_bypass.png" caption="fig.1 — AMSI patch visible in x64dbg memory view" >}}

## |=---[ References ]

- Stephen Fewer — "Reflective DLL Injection" (original paper)
- Phrack #72 — "Money for Nothing, Chips for Free"
- tmpout Vol. 3 — ELF reflective loading techniques
