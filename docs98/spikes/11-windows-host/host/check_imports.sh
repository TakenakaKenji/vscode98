#!/usr/bin/env bash
# Lists the DLLs and kernel32/user32/gdi32 functions a Windows exe imports and flags the ones that do not exist before Windows Vista (so the exe would not start on XP/2003).
# Usage: bash check_imports.sh <exe> [i686|x86_64]
set -euo pipefail
EXE=${1:?exe}; OBJDUMP=$([ "${2:-i686}" = x86_64 ] && echo x86_64-w64-mingw32-objdump || echo i686-w64-mingw32-objdump)
VISTA_PLUS='InitOnceExecuteOnce|InitializeConditionVariable|SleepConditionVariableCS|SleepConditionVariableSRW|WakeConditionVariable|WakeAllConditionVariable|GetTickCount64|CancelIoEx|CreateSymbolicLink[AW]|GetSystemTimePreciseAsFileTime|InitializeSRWLock|AcquireSRWLock(Exclusive|Shared)|ReleaseSRWLock(Exclusive|Shared)|GetFinalPathNameByHandle[AW]|WaitOnAddress|InitializeProcThreadAttributeList|UpdateProcThreadAttribute|SetFileInformationByHandle|GetFileInformationByHandleEx|CreateRemoteThreadEx|QueryFullProcessImageName[AW]|GetLocaleInfoEx|LCMapStringEx|CompareStringEx|GetUserDefaultLocaleName|SetThreadStackGuarantee|FlsAlloc|SetFileCompletionNotificationModes|RegGetValue[AW]|K32GetProcessMemoryInfo'
echo "DLLs:"; $OBJDUMP -p "$EXE" | grep "DLL Name" | sed 's/^\s*/  /'
echo "Vista-or-later functions imported (an exe importing any of these does not load on XP):"
$OBJDUMP -p "$EXE" | grep -E "^\s+[0-9a-f]+\s+[0-9]+\s+[A-Za-z_]" | awk '{print $NF}' | grep -E "^($VISTA_PLUS)$" | sort -u | sed 's/^/  /' || true
