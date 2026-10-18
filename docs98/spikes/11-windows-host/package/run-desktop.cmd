@echo off
rem Starts the vscode98 desktop workbench in a window (VS Code's own main process, shared process, extension host and renderer, all on the vscode98 host).
rem Boot takes minutes on a slow machine: the window shows the workbench as it builds. Close the window to quit. Log: results\desktop.txt (with a launch timeline and a sampling profile of all processes).
rem The first start compiles the large bundles and keeps their bytecode in userdata\code-cache; later starts read it instead.
rem Usage: run-desktop.cmd [width height]      (default 1000 700; the window must fit your screen)
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "Q=%HERE%\qjs-win-x86.exe"
set "JF=%HERE:\=/%/js"
set "W=%~1"
set "H=%~2"
if "%W%"=="" set "W=1000"
if "%H%"=="" set "H=700"
if not exist "%HERE%\results" mkdir "%HERE%\results"
if not exist "%HERE%\userdata" mkdir "%HERE%\userdata"
rem the previous run's log is kept as desktop-prev.txt (the second start reads the code cache written by the first: compare the two)
if exist "%HERE%\results\desktop.txt" move /y "%HERE%\results\desktop.txt" "%HERE%\results\desktop-prev.txt" >nul
echo Starting ... (log: %HERE%\results\desktop.txt)
rem the sampling profiler (every 2 ms, all processes): where each process spends its time, printed after the launch timeline; full tables in results\profile.txt
set "QJS98_PROFILE=2"
rem the time of the double-click, to compare with the harness start in the log (anything Windows does before the program runs)
echo [cmd] started at %TIME% > "%HERE%\results\desktop.txt"
"%Q%" --stack-size 0 "%JF%/docs98/spikes/05-child-process/host/fork_main.mjs" "%JF%/s11" "%JF%/docs98/spikes/10-main-shim/host/boot_desktop_qjs.mjs" "%HERE%\app" --layout native --backend native --window 1 --width %W% --height %H% --user-data-dir "%HERE%\userdata" --extensions-dir "%HERE%\userdata\extensions" --workspace "%HERE%\sample" --seconds 20 --stable 300 --echo-main 1 --debug-input 1 --status-every 5 --timeline "%HERE%\results\timeline" >> "%HERE%\results\desktop.txt" 2>&1
rem every run is also kept as results\run-1.txt, run-2.txt, ... (desktop-prev.txt holds only the one before): send all of them when comparing starts
set "N=1"
:nextrun
if exist "%HERE%\results\run-%N%.txt" set /a N+=1 & goto nextrun
copy /y "%HERE%\results\desktop.txt" "%HERE%\results\run-%N%.txt" >nul
echo Exited. Log: %HERE%\results\desktop.txt (also results\run-%N%.txt)
endlocal
