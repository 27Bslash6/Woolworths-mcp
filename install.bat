@echo off
echo Installing Woolworths MCP Server...
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
    echo pnpm is not installed! Run "corepack enable pnpm" ^(Node 22 or 24^),
    echo or see https://pnpm.io/installation.
    pause
    exit /b 1
)

echo Step 1: Installing dependencies from pnpm-lock.yaml...
call pnpm install --frozen-lockfile
if errorlevel 1 (
    echo Failed to install dependencies!
    rem Inside the project, older pnpm rejects pnpm-workspace.yaml or switches
    rem to the packageManager version, so read the version from outside it.
    echo Installed pnpm version:
    pushd "%TEMP%"
    call pnpm --version
    popd
    echo This project needs pnpm 11 ^(see packageManager in package.json^). Run "corepack enable pnpm" on Node 22 or 24, or see https://pnpm.io/installation.
    pause
    exit /b 1
)
echo.

echo Step 2: Installing Chrome for Puppeteer...
rem A successful install prints "chrome@<buildId> <path>". Some Node versions
rem make the zip extraction exit 0 with no browser, so check for that line.
pnpm exec puppeteer browsers install chrome | findstr /b /c:"chrome@"
if errorlevel 1 (
    echo Failed to install Chrome! Use Node 22 or 24, delete the puppeteer
    echo cache folder ^(%%USERPROFILE%%\.cache\puppeteer\chrome^) and run this script again.
    pause
    exit /b 1
)
echo.

echo Step 3: Building TypeScript code...
call pnpm run build
if errorlevel 1 (
    echo Failed to build project!
    pause
    exit /b 1
)
echo.

echo ========================================
echo Installation complete!
echo ========================================
echo.
echo Next steps:
echo 1. Add this to your Claude Desktop config:
echo.
echo    {
echo      "mcpServers": {
echo        "woolworths": {
echo          "command": "node",
rem JSON needs every backslash doubled, so double the ones in %%CD%% too.
echo          "args": ["%CD:\=\\%\\dist\\index.js"]
echo        }
echo      }
echo    }
echo.
echo 2. Restart Claude Desktop
echo.
echo Config file location:
echo Windows: %%APPDATA%%\Claude\claude_desktop_config.json
echo.
echo See SETUP.md for more details.
echo.
pause

