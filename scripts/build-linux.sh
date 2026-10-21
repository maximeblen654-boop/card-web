#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo 'Run this build in GitHub Actions to keep compilation off the local disk.' >&2
  exit 1
fi
root="${GITHUB_WORKSPACE:?}"
source_root="$root/upstream"
commit="$(node -p "require('./upstream.lock.json').commit")"
version="$(node -p "require('./upstream.lock.json').version")"
test "$(git -C "$source_root" rev-parse HEAD)" = "$commit"

pnpm --dir "$source_root/frontend/admin" install --frozen-lockfile
pnpm --dir "$source_root/frontend/user" install --frozen-lockfile
pnpm --dir "$source_root/frontend/admin" run build:fullstack
pnpm --dir "$source_root/frontend/user" run build
mkdir -p "$source_root/internal/web/dist/admin" "$source_root/internal/web/dist/user"
cp -R "$source_root/frontend/admin/dist/." "$source_root/internal/web/dist/admin/"
cp -R "$source_root/frontend/user/dist/." "$source_root/internal/web/dist/user/"

package="$RUNNER_TEMP/card-shop-package"
mkdir -p "$package/scripts" "$root/out"
cd "$source_root"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64
go mod download
go build -mod=readonly -trimpath -tags=release,fullstack \
  -ldflags "-s -w -X github.com/dujiao-next/internal/version.Version=${version}-cloud.${commit:0:7} -X github.com/dujiao-next/internal/version.BuildType=custom" \
  -o "$package/dujiao-next" ./cmd/server
cp LICENSE README.md config.yml.example "$package/"
cp scripts/dujiao-next-manager.sh "$package/scripts/"
cp "$root/upstream.lock.json" "$package/SOURCE.json"
cp "$root/upstream.lock.json" "$root/out/SOURCE.json"
archive="dujiao-next_${version}_cloud_Linux_x86_64.tar.gz"
tar -czf "$root/out/$archive" -C "$package" .
cd "$root/out"
sha256sum "$archive" > SHA256SUMS
sha256sum --check SHA256SUMS
file "$package/dujiao-next"
