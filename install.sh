#!/bin/bash

echo "Installing Woolworths MCP Server..."
echo ""

if ! command -v pnpm > /dev/null; then
    echo "pnpm is not installed! Run 'corepack enable pnpm' (Node 22 or 24),"
    echo "or see https://pnpm.io/installation."
    exit 1
fi

echo "Step 1: Installing dependencies from pnpm-lock.yaml..."
pnpm install --frozen-lockfile
if [ $? -ne 0 ]; then
    echo "Failed to install dependencies!"
    exit 1
fi
echo ""

echo "Step 2: Installing Chrome for Puppeteer..."
# A successful install prints "chrome@<buildId> <path>". Some Node versions
# make the zip extraction exit 0 with no browser, so check for that line.
pnpm exec puppeteer browsers install chrome | grep '^chrome@'
if [ $? -ne 0 ]; then
    echo "Failed to install Chrome! Use Node 22 or 24, delete the puppeteer"
    echo "cache folder (~/.cache/puppeteer/chrome) and run this script again."
    exit 1
fi
echo ""

echo "Step 3: Building TypeScript code..."
pnpm run build
if [ $? -ne 0 ]; then
    echo "Failed to build project!"
    exit 1
fi
echo ""

echo "========================================"
echo "Installation complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Add this to your Claude Desktop config:"
echo ""
echo '   {'
echo '     "mcpServers": {'
echo '       "woolworths": {'
echo '         "command": "node",'
echo "         \"args\": [\"$(pwd)/dist/index.js\"]"
echo '       }'
echo '     }'
echo '   }'
echo ""
echo "2. Restart Claude Desktop"
echo ""
echo "Config file location:"
echo "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "Linux: ~/.config/Claude/claude_desktop_config.json"
echo ""
echo "See SETUP.md for more details."
echo ""

