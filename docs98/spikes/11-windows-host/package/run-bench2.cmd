@echo off
rem Latency micro-benchmarks (timers, file system, big file, compile, process start). Output: results\bench2.txt
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
if not exist "%HERE%\results" mkdir "%HERE%\results"
"%HERE%\qjs-win-x86.exe" --stack-size 0 "%HERE%\bench2.js" "%HERE%\qjs-win-x86.exe" > "%HERE%\results\bench2.txt" 2>&1
type "%HERE%\results\bench2.txt"
endlocal
