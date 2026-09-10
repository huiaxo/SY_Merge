@echo off
title PNG Unpremultiply Tool
set "EXE=%~dp0fix_alpha.exe"
if not exist "%EXE%" (
    echo [ERROR] fix_alpha.exe not found: %EXE%
    ping -n 6 127.0.0.1 >nul
    exit /b 1
)
"%EXE%" %*
