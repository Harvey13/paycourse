@echo off
setlocal

if "%~1"=="" (
    echo Error: Please provide a version number.
    echo Usage: push_main.cmd version "Your version message here"
    exit /b 1
)

if "%~2"=="" (
    echo Error: Please provide a version message.
    echo Usage: push_main.cmd version "Your version message here"
    exit /b 1
)

set VERSION=%~1
set MESSAGE=%~2

REM Remove 'v' prefix if present
if "%VERSION:~0,1%"=="v" set VERSION=%VERSION:~1%

echo Pushing changes to git...

REM Basculez sur la branche main
git checkout main
if errorlevel 1 (
    echo Error: Failed to checkout main branch.
    exit /b 1
)

REM Récupérer les dernières modifications de main
git pull origin main
if errorlevel 1 (
    echo Error: Failed to pull latest changes from main.
    exit /b 1
)

REM Vérifie les modifications non commitées
git diff --quiet
if errorlevel 1 (
    echo Committing local changes...
    git add .
    git commit -m "feat: Version %VERSION%: %MESSAGE%"
    if errorlevel 1 (
        echo Error: Failed to commit changes.
        exit /b 1
    )
)

REM Créer un tag
git tag -a v%VERSION% -m "Version %VERSION%: %MESSAGE%"
if errorlevel 1 (
    echo Error: Failed to create the tag.
    exit /b 1
)

REM Pusher les changements et le tag
git push origin main
if errorlevel 1 (
    echo Error: Failed to push changes to main.
    exit /b 1
)

git push origin v%VERSION%
if errorlevel 1 (
    echo Error: Failed to push tag v%VERSION%.
    exit /b 1
)

echo Done.
pause
