@echo off
rem Builds the Ling interpreter with the in-process Stable Diffusion engine (crates\ling-diffusion, CUDA)
rem and installs it as bin\ling-diffusion.exe. nvcc needs MSVC's cl.exe, so this enters the VS 2022 x64
rem environment first. Builds into ..\ling\target-diffusion so the main ling.exe build is left alone.
rem   tools\build_engine.bat            interpreter with web + sd-cuda (what LingDiffusion runs on)
rem   tools\build_engine.bat example    only the engine's command-line smoke test (examples\gen.rs)
setlocal
set ROOT=%~dp0..
set LING=%ROOT%\..\ling
set VCVARS=
for %%V in (
  "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) do if not defined VCVARS if exist %%V set VCVARS=%%V
if not defined VCVARS (
  echo Visual Studio 2022 C++ tools not found ^(nvcc needs cl.exe^).
  exit /b 1
)
call %VCVARS% >nul
cd /d "%LING%"
if /i "%1"=="example" (
  cargo build -p ling-diffusion --release --features cuda --examples --target-dir target-diffusion
  exit /b %errorlevel%
)
cargo build --release --bin ling --no-default-features --features web,sd-cuda --target-dir target-diffusion
if errorlevel 1 exit /b 1
copy /y "%LING%\target-diffusion\release\ling.exe" "%ROOT%\bin\ling-diffusion.exe" >nul
echo Installed bin\ling-diffusion.exe
exit /b 0
