#!/bin/bash
# Deploy to the locally-running plugin instance, whose Scrypted plugin id is
# "@scrypted/unifi-direct" (the original name, to which the cameras + HomeKit
# pairings are bound). The published package name is "scrypted-unifi-direct";
# this script temporarily swaps package.json's name so `scrypted-deploy` targets
# the running instance, then restores it — so the repo stays publish-consistent.
#
# Usage: ./deploy-local.sh [host:port]   (default 192.168.50.11:10443)
set -e
cd "$(dirname "$0")"
LOCAL_ID="@scrypted/unifi-direct"
TARGET="${1:-192.168.50.11:10443}"
ORIG=$(node -e "console.log(require('./package.json').name)")
restore() { node -e "const fs=require('fs');const p=require('./package.json');p.name='$ORIG';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"; }
trap restore EXIT
node -e "const fs=require('fs');const p=require('./package.json');p.name='$LOCAL_ID';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
rm -rf out
npm run build
npx scrypted-deploy "$TARGET"
