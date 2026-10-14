@echo off
rem CPU/memory micro-benchmarks (about 1 minute on a normal PC). Compare the numbers with another machine. Output: results\bench.txt
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
if not exist "%HERE%\results" mkdir "%HERE%\results"
"%HERE%\qjs-win-x86.exe" --stack-size 0 "%HERE%\bench.js" > "%HERE%\results\bench.txt" 2>&1
type "%HERE%\results\bench.txt"
endlocal
