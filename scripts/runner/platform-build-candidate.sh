#!/usr/bin/env bash
# T-244: build all platform components without changing any running stand.
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
git diff --quiet HEAD -- . ':!.claude' || { echo 'Candidate source must be committed'; exit 64; }
build_root=${PLATFORM_BUILD_ROOT:-/opt/resource-ocr/platform-builds}
builder=platform-handoff
cpuset=${PLATFORM_BUILD_CPUSET:-$(awk '/Cpus_allowed_list:/ {print $2}' /proc/self/status)}
[[ "$cpuset" =~ ^[0-9,-]+$ ]] || { echo 'Invalid builder CPU set'; exit 64; }
umask 077
mkdir -p "$build_root"
exec 9>"$build_root/build.lock"
flock -n 9 || { echo 'Another platform candidate build is active'; exit 75; }
output="$build_root/$revision"
mkdir "$output"
# Other runner lanes may check out the same branch. Build from the exact
# committed tree instead of observing that mutable workspace during COPY.
mkdir "$output/source"
git archive "$revision" | tar -xf - -C "$output/source"
if ! docker buildx version >/dev/null 2>&1; then
  # The runner installs verified CLI plugins outside the isolated job home.
  # Keep builder metadata private instead of changing its shared config.
  test -x /opt/w1-gate/tools/docker/cli-plugins/docker-buildx || {
    echo 'Docker Buildx is required'; exit 64;
  }
  mkdir -p "$build_root/docker-config"
  # Builder metadata must survive revisions. Reuse the private metadata from
  # an earlier invocation; a fresh per-revision config would collide with the
  # still-existing BuildKit container of the same name.
  if [ ! -d "$build_root/docker-config/buildx" ]; then
    previous=$(find "$build_root" -mindepth 3 -maxdepth 3 -type d -path '*/docker-config/buildx' -print -quit)
    [ -z "$previous" ] || cp -a "$previous" "$build_root/docker-config/buildx"
  fi
  printf '%s\n' '{"cliPluginsExtraDirs":["/opt/w1-gate/tools/docker/cli-plugins"]}' \
    >"$build_root/docker-config/config.json"
  export DOCKER_CONFIG="$build_root/docker-config"
fi
# Pin the build engine as well as the runtime FROM images in the Dockerfiles.
engine=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8
docker buildx inspect "$builder" >/dev/null 2>&1 || docker buildx create --name "$builder" \
  --driver docker-container --driver-opt "image=$engine" --driver-opt "\"cpuset-cpus=$cpuset\"" \
  --driver-opt memory=8g --driver-opt memory-swap=8g --driver-opt cpu-shares=512 >/dev/null
docker buildx inspect --bootstrap "$builder" >/dev/null
docker update --cpus 6 --cpuset-cpus "$cpuset" --memory 8g --memory-swap 8g \
  "buildx_buildkit_${builder}0" >/dev/null
build() {
  local component=$1 dockerfile=$2
  shift 2
  docker buildx build --builder "$builder" --load --progress plain \
    --build-arg "REVISION=$revision" -f "$output/source/$dockerfile" \
    -t "inspector-platform-$component:$revision" "$@" "$output/source" >"$output/$component.log" 2>&1
}
build api apps/api/Dockerfile & api_job=$!
build web apps/web/Dockerfile & web_job=$!
build ml ml/Dockerfile --target gpu & ml_job=$!
failed=0
for job in "$api_job" "$web_job" "$ml_job"; do wait "$job" || failed=1; done
if [ "$failed" != 0 ]; then
  echo "Candidate build failed; private logs: $output"
  exit 1
fi
python3 - "$revision" "$output" <<'PY'
import json, pathlib, subprocess, sys
revision, output = sys.argv[1:]
images = {}
for component in ('api', 'web', 'ml'):
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect',
                       f'inspector-platform-{component}:{revision}']))[0]
    if image['Config']['Labels']['org.opencontainers.image.revision'] != revision:
        raise RuntimeError('image revision mismatch')
    images[component] = image['Id']
manifest = {'schema': 'platform-candidate-images/1', 'revision': revision, 'images': images,
            'running_stands_changed': False, 'ml_profile': 'gpu'}
pathlib.Path(output, 'images.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest))
PY
