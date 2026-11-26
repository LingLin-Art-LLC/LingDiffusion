@echo off
rem LingDiffusion launcher: runs app.ling on bin\ling-diffusion.exe (the Ling interpreter built with the
rem in-process Stable Diffusion engine; tools\build_engine.bat makes it) and opens the page.
rem   run.bat                         http://127.0.0.1:7860 on the GPU with the most free memory
rem   run.bat --device cuda:1         render on a given GPU (cuda:0, cuda:1, cpu)
rem   run.bat --listen 0.0.0.0        share on the LAN
rem   run.bat --port 7861 --models D:\sd\models --loras D:\sd\lora
setlocal
set ROOT=%~dp0
set EXE=%ROOT%bin\ling-diffusion.exe
if not exist "%EXE%" (
  echo bin\ling-diffusion.exe is missing. Build it with:  tools\build_engine.bat
  pause
  exit /b 1
)
set PORT=7860
set NEXT=
for %%A in (%*) do call :arg "%%~A"
cd /d "%ROOT%"
set RUST_BACKTRACE=1
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:%PORT%/"
"%EXE%" run --interp app.ling %*
if errorlevel 1 (
  echo LingDiffusion stopped with an error.
  pause
)
exit /b 0

:arg
if defined NEXT (
  set "PORT=%~1"
  set NEXT=
)
if /i "%~1"=="--port" set NEXT=1
exit /b 0
