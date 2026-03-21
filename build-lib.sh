#!/bin/bash

# Script to build the wyze-bridge library and then npm install
# in the plugin repository

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/wyze-bridge"

echo "📦 Building @camstack/wyze-bridge library..."
cd "${LIB_DIR}"
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Library build failed!"
    exit 1
fi

echo "✅ Library built successfully!"
echo ""
echo "📦 Installing dependencies in plugin..."
cd "${SCRIPT_DIR}"
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install failed!"
    exit 1
fi

echo "✅ All done!"
