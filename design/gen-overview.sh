#!/bin/sh
# Overview.dc.html is Main.dc.html opened on the root node: same prototype, different
# initial view and matching static placeholders. Regenerate after every change to Main.
set -e
cd "$(dirname "$0")"
sed -e 's/"initialView":{"editor":"enum","options":\["worktree","project","all"\],"default":"worktree"/"initialView":{"editor":"enum","options":["worktree","project","all"],"default":"all"/' \
    -e 's/value="{{isTable}}" hint-placeholder-val="{{false}}"/value="{{isTable}}" hint-placeholder-val="{{true}}"/' \
    -e 's/value="{{isRoot}}" hint-placeholder-val="{{false}}"/value="{{isRoot}}" hint-placeholder-val="{{true}}"/' \
    -e 's/value="{{isWorktree}}" hint-placeholder-val="{{true}}"/value="{{isWorktree}}" hint-placeholder-val="{{false}}"/' \
    Main.dc.html > Overview.dc.html
