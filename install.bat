@echo off
echo Installing Woolworths MCP Server...
echo.

echo Step 1: Installing dependencies from package-lock.json...
call npm ci --ignore-scripts
if errorlevel 1 (
    echo Failed to install dependencies!
    pause
    exit /b 1
)
echo.

echo Step 2: Installing Chrome for Puppeteer...
rem A successful install prints "chrome@<buildId> <path>". Some Node versions
rem make the zip extraction exit 0 with no browser, so check for that line.
npx --no puppeteer browsers install chrome | findstr /b /c:"chrome@"
if errorlevel 1 (
    echo Failed to install Chrome! Use Node 22 or 24, delete the puppeteer
    echo cache folder ^(%%USERPROFILE%%\.cache\puppeteer\chrome^) and run this script again.
    pause
    exit /b 1
)
echo.

echo Step 3: Building TypeScript code...
call npm run build
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
echo          "args": ["%CD%\\dist\\index.js"]
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

