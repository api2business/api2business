#!/bin/sh
set -eu

source_root=${SOURCE_ROOT:?SOURCE_ROOT is required}
source_commit=${SOURCE_COMMIT:?SOURCE_COMMIT is required}
image_repository=${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}
dockerfile=${DOCKERFILE:?DOCKERFILE is required}
build_network=${BUILD_NETWORK:?BUILD_NETWORK is required}
metadata_file=${BUILD_METADATA_FILE:?BUILD_METADATA_FILE is required}
result_file=${BUILD_RESULT_FILE:?BUILD_RESULT_FILE is required}

case "$source_commit" in
  *[!0-9a-f]*|'') printf '%s\n' 'SOURCE_COMMIT must be a full lowercase Git SHA' >&2; exit 2 ;;
esac
[ "${#source_commit}" -eq 40 ] || { printf '%s\n' 'SOURCE_COMMIT must be 40 characters' >&2; exit 2; }
[ "$build_network" = host ] || { printf '%s\n' 'BUILD_NETWORK must be host' >&2; exit 2; }
case "$dockerfile" in
  /*|*../*|*/..|..) printf '%s\n' 'DOCKERFILE must be a safe relative path' >&2; exit 2 ;;
esac
[ -f "$source_root/$dockerfile" ] || { printf '%s\n' 'Dockerfile is missing' >&2; exit 2; }

image_ref="$image_repository:$(printf '%s' "$source_commit" | cut -c1-12)"
rm -f "$metadata_file" "$result_file"

buildctl-daemonless.sh build \
  --allow network.host \
  --frontend dockerfile.v0 \
  --local context="$source_root" \
  --local dockerfile="$source_root" \
  --opt "filename=$dockerfile" \
  --opt "network=$build_network" \
  --opt "build-arg:HTTP_PROXY=${HTTP_PROXY:-}" \
  --opt "build-arg:HTTPS_PROXY=${HTTPS_PROXY:-}" \
  --opt "build-arg:ALL_PROXY=${ALL_PROXY:-}" \
  --opt "build-arg:NO_PROXY=${NO_PROXY:-}" \
  --metadata-file "$metadata_file" \
  --output "type=image,name=$image_ref,push=true,registry.insecure=true"

[ -s "$metadata_file" ] || { printf '%s\n' 'BuildKit metadata is missing' >&2; exit 2; }
digest=$(tr -d '\n' < "$metadata_file" | sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf '%s\n' 'BuildKit metadata digest is invalid' >&2; exit 2 ;;
esac

printf '{"ok":true,"phase":"image-build","status":"built","imageStatus":"built","sourceCommit":"%s","imageRef":"%s","digest":"%s","digestRef":"%s@%s","valuesPrinted":false}\n' \
  "$source_commit" "$image_ref" "$digest" "$image_repository" "$digest" > "$result_file"
cat "$result_file"
