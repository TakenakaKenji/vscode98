@echo off
rem Self test of the vscode98 host on Windows. Writes everything to the "results" folder next to this file; send that folder back.
rem Usage: selftest.cmd            (the window test asks you to move the mouse over the window, click, scroll and type for about 15 seconds)
setlocal EnableDelayedExpansion
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "Q=%HERE%\qjs-win-x86.exe"
set "JF=%HERE:\=/%/js"
set "R=%HERE%\results"
if not exist "%R%" mkdir "%R%"
echo vscode98 host self test > "%R%\00-system.txt"
ver >> "%R%\00-system.txt"
echo. >> "%R%\00-system.txt"
systeminfo 2>nul | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory" /C:"Available Physical Memory" >> "%R%\00-system.txt"
wmic cpu get Name,NumberOfCores,MaxClockSpeed /format:list 2>nul >> "%R%\00-system.txt"
echo.
echo [1/5] host starts ...
"%Q%" -e "console.log('hello from', typeof globalThis)" > "%R%\01-hello.txt" 2>&1
type "%R%\01-hello.txt"
echo [2/5] processes, pipes, exit codes, kill ...
"%Q%" --stack-size 0 "%JF%/docs98/spikes/11-windows-host/tests/proc_raw.mjs" > "%R%\02-proc_raw.txt" 2>&1
findstr /B "PASS FAIL ALL" "%R%\02-proc_raw.txt"
echo [3/5] child_process.fork with IPC (Node shims) ...
"%Q%" --stack-size 0 "%JF%/docs98/spikes/05-child-process/host/fork_main.mjs" "%JF%/s11" "%JF%/docs98/spikes/05-child-process/tests/fork_parent.cjs" > "%R%\03-fork.txt" 2>&1
type "%R%\03-fork.txt"
echo [4/5] net over named pipes ...
"%Q%" --stack-size 0 "%JF%/docs98/spikes/05-child-process/host/fork_main.mjs" "%JF%/s11" "%JF%/docs98/spikes/11-windows-host/tests/net_pipe.cjs" > "%R%\04-net_pipe.txt" 2>&1
type "%R%\04-net_pipe.txt"
echo [5/5] window (GDI): a window opens for 15 seconds. Move the mouse over it, click, scroll the wheel and type a few keys ...
"%Q%" --stack-size 0 "%JF%/docs98/spikes/11-windows-host/tests/win_gdi.mjs" --seconds 15 > "%R%\05-window.txt" 2>&1
type "%R%\05-window.txt"
echo.
echo Done. Please send the folder "%R%" back.
endlocal
