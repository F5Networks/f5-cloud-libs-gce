#!/bin/bash
if [[ $1 == '--production' ]]; then
    npx npm-force-resolutions
    npm install --production
    rm -rf node_modules/@f5devcentral
fi

tar -C .. --exclude=".git*" --exclude="${PWD##*/}/test" --exclude="${PWD##*/}/dist" --exclude="${PWD##*/}/build" --exclude="${PWD##*/}/doc" --exclude="${PWD##*/}/gitHooks" -cf dist/f5-cloud-libs-gce.tar f5-cloud-libs-gce

# Suppress gzips timetamp in the tarball - otherwise the digest hash changes on each
# commit even if the contents do not change. This causes an infinite loop in the build scripts
# due to packages triggering each other to uptdate hashes.
gzip -nf dist/f5-cloud-libs-gce.tar
