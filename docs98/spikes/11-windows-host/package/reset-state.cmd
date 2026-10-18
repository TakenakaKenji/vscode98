@echo off
rem Puts the program back to a first start: forgets the open editors, panels, window state and history of earlier runs (userdata), keeps the bytecode cache (userdata\code-cache).
rem Run it between tests so that every start does the same work: later starts restore what the earlier ones left open (editors, the terminal, the TypeScript servers a .js file starts).
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
if not exist "%HERE%\userdata" goto done
for /d %%D in ("%HERE%\userdata\*") do if /i not "%%~nxD"=="code-cache" rmdir /s /q "%%D"
for %%F in ("%HERE%\userdata\*") do del /q "%%F" >nul 2>&1
:done
echo Done: the next start is a first start (the code cache is kept).
endlocal
