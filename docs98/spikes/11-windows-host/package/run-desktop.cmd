@echo off
rem Starts the vscode98 desktop workbench in a window (VS Code's own main process, shared process, extension host and renderer, all on the vscode98 host).
rem Boot takes minutes on a slow machine: the window shows the workbench as it builds. Close the window to quit. Log: results\desktop.txt (with a launch timeline of all processes).
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
"%Q%" --stack-size 0 "%JF%/docs98/spikes/05-child-process/host/fork_main.mjs" "%JF%/s11" "%JF%/docs98/spikes/10-main-shim/host/boot_desktop_qjs.mjs" "%HERE%\app" --layout native --backend native --window 1 --width %W% --height %H% --user-data-dir "%HERE%\userdata" --extensions-dir "%HERE%\userdata\extensions" --workspace "%HERE%\sample" --seconds 20 --stable 300 --echo-main 1 --debug-input 1 --timeline "%HERE%\results\timeline" > "%HERE%\results\desktop.txt" 2>&1
echo Exited. Log: %HERE%\results\desktop.txt
endlocal
