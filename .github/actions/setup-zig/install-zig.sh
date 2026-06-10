#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <zig-version>" >&2
  exit 1
fi

version="$1"
case "$version" in
  "" | .* | -* | *..* | */* | *\\* | *[!A-Za-z0-9._+-]*)
    echo "invalid Zig version" >&2
    exit 1
    ;;
esac

python_bin="${PYTHON:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  python_bin="python"
fi
if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "python is required to resolve Zig download metadata before Zig is installed" >&2
  exit 1
fi

runner_os="${RUNNER_OS:-$(uname -s)}"
runner_arch="${RUNNER_ARCH:-$(uname -m)}"

case "$runner_os" in
  Linux | linux)
    zig_os="linux"
    ;;
  Darwin | macOS)
    zig_os="macos"
    ;;
  Windows | MINGW* | MSYS* | CYGWIN*)
    zig_os="windows"
    ;;
  *)
    echo "unsupported runner OS: $runner_os" >&2
    exit 1
    ;;
esac

case "$runner_arch" in
  X64 | x86_64 | amd64)
    zig_arch="x86_64"
    ;;
  ARM64 | arm64 | aarch64)
    zig_arch="aarch64"
    ;;
  *)
    echo "unsupported runner architecture: $runner_arch" >&2
    exit 1
    ;;
esac

host_key="${zig_arch}-${zig_os}"
temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
case "$temp_root" in
  "" | *$'\n'* | *$'\r'*)
    echo "invalid temporary directory" >&2
    exit 1
    ;;
esac

tool_root="${temp_root}/nullbuilder-zig"
install_dir="${tool_root}/${version}/${host_key}"
zig_bin="zig"
if [ "$zig_os" = "windows" ]; then
  zig_bin="zig.exe"
fi

if [ ! -x "${install_dir}/${zig_bin}" ]; then
  mkdir -p "$(dirname "$install_dir")"

  zig_metadata="$(
    "$python_bin" - "$version" "$host_key" <<'PY'
import json
import re
import sys
import urllib.parse
import urllib.request

version = sys.argv[1]
host_key = sys.argv[2]
METADATA_URL = "https://ziglang.org/download/index.json"
METADATA_TIMEOUT_SECONDS = 30
MAX_METADATA_BYTES = 2 * 1024 * 1024

def ensure_metadata_url(value: str) -> None:
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "ziglang.org"
        or parsed.path != "/download/index.json"
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("invalid Zig download metadata URL")

with urllib.request.urlopen(METADATA_URL, timeout=METADATA_TIMEOUT_SECONDS) as response:
    ensure_metadata_url(response.geturl())
    metadata = response.read(MAX_METADATA_BYTES + 1)

if len(metadata) > MAX_METADATA_BYTES:
    raise SystemExit("Zig download metadata is too large")

try:
    data = json.loads(metadata.decode("utf-8"))
except UnicodeDecodeError as err:
    raise SystemExit("invalid UTF-8 in Zig download metadata") from err

host = data.get(version, {}).get(host_key)
if not host:
    raise SystemExit(f"missing Zig download metadata for version={version!r} host={host_key!r}")

archive_url = host.get("tarball") or host.get("zip")
checksum = host.get("shasum") or ""
if not archive_url:
    raise SystemExit(f"missing archive URL for version={version!r} host={host_key!r}")

if not isinstance(archive_url, str):
    raise SystemExit("invalid Zig archive URL in download metadata")

parsed_url = urllib.parse.urlparse(archive_url)
if (
    parsed_url.scheme != "https"
    or parsed_url.netloc != "ziglang.org"
    or parsed_url.query
    or parsed_url.fragment
    or not (parsed_url.path.startswith("/download/") or parsed_url.path.startswith("/builds/"))
    or not (parsed_url.path.endswith(".tar.xz") or parsed_url.path.endswith(".zip"))
):
    raise SystemExit("invalid Zig archive URL in download metadata")

if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
    raise SystemExit("invalid Zig archive checksum in download metadata")

print(archive_url)
print(checksum.lower())
PY
  )"

  archive_url="$(printf '%s\n' "$zig_metadata" | sed -n '1p')"
  expected_sha="$(printf '%s\n' "$zig_metadata" | sed -n '2p')"
  if [ -z "$archive_url" ]; then
    echo "failed to resolve Zig download URL" >&2
    exit 1
  fi

  archive_name="${archive_url##*/}"
  case "$archive_name" in
    "" | .* | -* | *..* | */* | *\\* | *$'\n'* | *$'\r'* | *[!A-Za-z0-9._+-]*)
      echo "invalid Zig archive filename" >&2
      exit 1
      ;;
  esac
  case "$archive_name" in
    *.tar.xz | *.zip)
      ;;
    *)
      echo "invalid Zig archive filename" >&2
      exit 1
      ;;
  esac

  archive_dir="$(mktemp -d "${temp_root}/zig-archive.XXXXXX")"
  archive_path="${archive_dir}/${archive_name}"
  extract_dir="$(mktemp -d "${temp_root}/zig-extract.XXXXXX")"
  trap 'rm -rf "$archive_dir"; rm -rf "$extract_dir"' EXIT

  curl -fsSL --retry 3 --retry-all-errors --proto '=https' --proto-redir '=https' "$archive_url" -o "$archive_path"

  "$python_bin" - "$archive_path" "$expected_sha" <<'PY'
import hashlib
import sys

path = sys.argv[1]
expected = sys.argv[2].strip().lower()
if not expected:
    raise SystemExit(0)

digest = hashlib.sha256()
with open(path, "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)

actual = digest.hexdigest().lower()
if actual != expected:
    raise SystemExit(f"checksum mismatch for {path}: expected {expected}, got {actual}")
PY

  "$python_bin" - "$archive_path" "$extract_dir" <<'PY'
import pathlib
import inspect
import stat
import sys
import tarfile
import zipfile

archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)

def ensure_within_destination(relative_name: str) -> None:
    target = (destination / relative_name).resolve()
    if destination.resolve() not in target.parents and target != destination.resolve():
        raise SystemExit(f"archive entry escapes destination: {relative_name}")

def ensure_safe_zip_member(member: zipfile.ZipInfo) -> None:
    ensure_within_destination(member.filename)
    mode = member.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if file_type in {stat.S_IFLNK, stat.S_IFBLK, stat.S_IFCHR, stat.S_IFIFO, stat.S_IFSOCK}:
        raise SystemExit(f"unsafe zip entry type: {member.filename}")

def ensure_safe_tar_member(member: tarfile.TarInfo) -> None:
    ensure_within_destination(member.name)
    if not (member.isdir() or member.isfile()):
        raise SystemExit(f"unsafe tar entry type: {member.name}")

def tar_extract_kwargs() -> dict:
    if "filter" in inspect.signature(tarfile.TarFile.extractall).parameters:
        return {"filter": "data"}
    return {}

if archive.suffix == ".zip":
    with zipfile.ZipFile(archive) as handle:
        for member in handle.infolist():
            ensure_safe_zip_member(member)
        handle.extractall(destination)
else:
    with tarfile.open(archive, "r:*") as handle:
        for member in handle.getmembers():
            ensure_safe_tar_member(member)
        handle.extractall(destination, **tar_extract_kwargs())

top_level_entries = list(destination.iterdir())
if len(top_level_entries) != 1 or not top_level_entries[0].is_dir():
    raise SystemExit("unexpected Zig archive layout")
PY

  extracted_dir="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  if [ -z "$extracted_dir" ] || [ ! -x "${extracted_dir}/${zig_bin}" ]; then
    echo "failed to extract Zig executable: $archive_url" >&2
    exit 1
  fi

  rm -rf "$install_dir"
  mv "$extracted_dir" "$install_dir"
fi

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
else
  echo "GITHUB_PATH is not set; add this directory to PATH manually: $install_dir" >&2
fi

"${install_dir}/${zig_bin}" version
