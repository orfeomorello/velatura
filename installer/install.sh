#!/usr/bin/env bash
#
# Velatura installer — Linux and macOS.
#
#   curl -fsSL https://…/install.sh | bash
#   bash install.sh --from ./velatura-app-0.1.6.tar.gz      (offline)
#
# It installs the program and a `velatura` command in your PATH. It reuses
# Node 20.19+ if it is already on the machine; otherwise it installs a
# checksum-verified portable runtime in your home folder. Nothing is installed
# system-wide, no administrator rights needed.
#
set -euo pipefail

VERSION="0.1.6"
NODE_VERSION="v20.19.0"

INSTALL_DIR="${VELATURA_HOME:-$HOME/.velatura}"
BIN_DIR=""
# where the release lives; the installer fetches the archive from here
BASE_URL="https://github.com/orfeomorello/velatura/releases/latest/download"
FROM=""
USE_SYSTEM_NODE=0
LAUNCH=1
ASSUME_YES=0
UNINSTALL=0

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Velatura installer

  --from <file>     install from a local archive (no download)
  --url <base>      base URL of the release (default: none, you must pass --from)
  --dir <path>      where to install (default: ~/.velatura)
  --node <path>     use this Node instead of downloading one
  --no-launch       do not start Velatura at the end
  --uninstall       remove what this installer put in your home folder
  -y, --yes         do not ask questions
  -h, --help        this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --url) BASE_URL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --node) USE_SYSTEM_NODE=1; NODE_BIN="$2"; shift 2 ;;
    --no-launch) LAUNCH=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux) OS=linux; EXT=tar.xz ;;
  Darwin) OS=darwin; EXT=tar.gz ;;
  *) die "this installer covers Linux and macOS. On Windows use install.ps1." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Windows Subsystem for Linux: it is a Linux system, so the installer works,
# but the program would live inside the subsystem and not on Windows. A
# person who typed "bash install.sh" in the Windows terminal most likely
# wants the Windows version: we say so, plainly, before doing anything.
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi "microsoft" /proc/version 2>/dev/null; then
  cat <<'EOF'

  This is Windows Subsystem for Linux (WSL).

  Velatura would be installed inside the subsystem, not on Windows: the
  program, the models and the pictures would stay in the Linux side.

  If you want the Windows version, close this and use PowerShell:

      powershell -ExecutionPolicy Bypass -File installer/install.ps1

  If you really want it here, carry on: press Enter.

EOF
  if [ "$ASSUME_YES" = "0" ] && [ -r /dev/tty ]; then
    read -r -p "  Press Enter to continue, or Ctrl+C to stop: " _ || exit 1
  fi
fi

# ------------------------------------------------------------- uninstall ----
if [ "$UNINSTALL" = "1" ]; then
  step "Velatura $VERSION — removing"
  BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
  LAUNCHER="$BIN_DIR/velatura"
  DESKTOP_FILE="$HOME/.local/share/applications/velatura.desktop"
  SHELL_RC=""
  case "${SHELL:-}" in
    */zsh) SHELL_RC="$HOME/.zprofile" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
    *) [ -f "$HOME/.zprofile" ] && SHELL_RC="$HOME/.zprofile" || SHELL_RC="$HOME/.profile" ;;
  esac

  say "this will remove:"
  [ -d "$INSTALL_DIR" ] && say "  $INSTALL_DIR (the program, the runtime, the pictures)"
  [ -f "$LAUNCHER" ] && say "  $LAUNCHER (the command)"
  [ -f "$DESKTOP_FILE" ] && say "  $DESKTOP_FILE (the shortcut)"
  [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ] && say "  the line about Velatura in $SHELL_RC"
  say ""
  say "your models, your pictures and your history are inside $INSTALL_DIR:"
  say "they go away with it. Everything else on this machine stays."

  if [ "$ASSUME_YES" = "0" ]; then
    if [ -r /dev/tty ]; then
      read -r -p "  Remove them? [y/N] " answer || exit 1
    else
      answer="n"
    fi
    case "$answer" in
      [Yy]|[Yy][Ee][Ss]) ;;
      *) say "nothing was removed"; exit 0 ;;
    esac
  fi

  # the line of the PATH, and the comment above it
  if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
    tmp_rc="$SHELL_RC.velatura.tmp"
    awk -v bin="$BIN_DIR" '
      /^# *Velatura *$/ { next }
      index($0, bin) { next }
      { print }
    ' "$SHELL_RC" > "$tmp_rc" && mv "$tmp_rc" "$SHELL_RC"
    say "cleaned $SHELL_RC"
  fi

  rm -f "$LAUNCHER" "$DESKTOP_FILE"
  say "removed the command and the shortcut"

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    say "removed $INSTALL_DIR"
  fi

  step "Done"
  say "Velatura is not on this machine any more."
  exit 0
fi

step "Velatura $VERSION — installing for $OS/$ARCH"

# ---------------------------------------------------------------- runtime ----
# the checksum of a file, on every system: macOS has no sha256sum, it has
# shasum. If neither is there, we cannot check: we say so and we go on.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

# the Node of the machine is enough when it is new enough: the program needs
# 20.19 or more. A portable runtime is the second choice, not the first.
MIN_NODE="20.19"

node_is_new_enough() {
  local exe="$1" ver major minor
  [ -n "$exe" ] && [ -x "$exe" ] || return 1
  ver=$("$exe" --version 2>/dev/null | head -1) || return 1
  ver=${ver#v}
  major=${ver%%.*}
  minor=${ver#*.}
  minor=${minor%%.*}
  case "${major}${minor}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -gt 20 ] && return 0
  [ "$major" -eq 20 ] && [ "$minor" -ge 19 ] && return 0
  return 1
}

# the Node that is already on the machine
find_system_node() {
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "/usr/local/bin/node" \
    "/usr/bin/node" \
    "/opt/homebrew/bin/node" \
    "/opt/local/bin/node"; do
    [ -n "$candidate" ] || continue
    if node_is_new_enough "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

step "1/4  Checking Node.js"

if [ "$USE_SYSTEM_NODE" = "1" ]; then
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  [ -n "$NODE_BIN" ] || die "no Node found at the requested path"
  node_is_new_enough "$NODE_BIN" \
    || die "the Node at $NODE_BIN is too old: we need $MIN_NODE or more"
  say "using $NODE_BIN ($("$NODE_BIN" --version))"
else
  # Prefer the machine's compatible Node over a private copy. Reuse an
  # already verified private runtime only when no suitable system Node exists.
  SYSTEM_NODE="$(find_system_node || true)"
  RUNTIME_DIR="$INSTALL_DIR/runtime"
  if [ -n "$SYSTEM_NODE" ]; then
    NODE_BIN="$SYSTEM_NODE"
    say "using the Node already on this machine: $NODE_BIN ($("$NODE_BIN" --version))"
    say "nothing was downloaded"
  elif [ -x "$RUNTIME_DIR/bin/node" ] && node_is_new_enough "$RUNTIME_DIR/bin/node"; then
    NODE_BIN="$RUNTIME_DIR/bin/node"
    say "using the private runtime already installed: $("$NODE_BIN" --version)"
  else
    if [ -x "$RUNTIME_DIR/bin/node" ]; then
      say "the private Node runtime is too old; it will be replaced"
    fi
    NODE_URL="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$OS-$ARCH.$EXT"
    ARCHIVE="$INSTALL_DIR/node.$EXT"
    mkdir -p "$INSTALL_DIR"
    say "downloading $(basename "$ARCHIVE")"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 -o "$ARCHIVE" "$NODE_URL" || die "download failed: $NODE_URL"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$ARCHIVE" "$NODE_URL" || die "download failed: $NODE_URL"
    else
      die "curl or wget is required to download the private Node runtime"
    fi

    # The fallback runtime is never unpacked until its checksum is verified
    # against Node.js' official SHASUMS256.txt.
    SUMS_URL="https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 -o "$INSTALL_DIR/node.sha256" "$SUMS_URL" \
        || { rm -f "$ARCHIVE"; die "could not download the official Node checksum list"; }
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$INSTALL_DIR/node.sha256" "$SUMS_URL" \
        || { rm -f "$ARCHIVE"; die "could not download the official Node checksum list"; }
    else
      rm -f "$ARCHIVE"
      die "curl or wget is required to verify the private Node runtime"
    fi
    EXPECTED=$(awk -v f="node-$NODE_VERSION-$OS-$ARCH.$EXT" '$2 == f { print $1; exit }' "$INSTALL_DIR/node.sha256")
    ACTUAL=$(sha256_of "$ARCHIVE")
    if [ -z "$EXPECTED" ] || [ -z "$ACTUAL" ]; then
      rm -f "$ARCHIVE" "$INSTALL_DIR/node.sha256"
      die "could not verify the Node runtime checksum; nothing was installed"
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      rm -f "$ARCHIVE" "$INSTALL_DIR/node.sha256"
      die "checksum mismatch for the Node runtime — download aborted"
    fi
    say "Node runtime checksum verified"
    rm -f "$INSTALL_DIR/node.sha256"

    rm -rf "$RUNTIME_DIR"
    mkdir -p "$RUNTIME_DIR"
    if ! tar -xJf "$ARCHIVE" -C "$RUNTIME_DIR" --strip-components=1 2>/dev/null; then
      tar -xzf "$ARCHIVE" -C "$RUNTIME_DIR" --strip-components=1 \
        || { rm -f "$ARCHIVE"; die "could not unpack the Node runtime"; }
    fi
    rm -f "$ARCHIVE"
    NODE_BIN="$RUNTIME_DIR/bin/node"
    node_is_new_enough "$NODE_BIN" || die "the downloaded Node runtime failed its version check"
    say "installed $("$NODE_BIN" --version)"
  fi
fi

# ------------------------------------------------------------------- app ----
step "2/4  Velatura itself"

APP_DIR="$INSTALL_DIR/app"
mkdir -p "$INSTALL_DIR"
APP_ARCHIVE_NAME="velatura-app-$VERSION.tar.gz"
if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "archive not found: $FROM"
  say "using $FROM"
  APP_ARCHIVE="$FROM"
  CHECKSUM_FILE="$(dirname "$FROM")/SHASUMS256.txt"
  [ -f "$CHECKSUM_FILE" ] || die "local application checksum list not found: $CHECKSUM_FILE"
else
  [ -n "$BASE_URL" ] || die "no source: use --from <archive> or --url <base url>"
  say "downloading from $BASE_URL"
  APP_ARCHIVE="$INSTALL_DIR/velatura-app.tar.gz"
  CHECKSUM_FILE="$APP_ARCHIVE.sums"
  say "downloading the application"
  curl -fsSL --retry 3 -o "$APP_ARCHIVE" "$BASE_URL/$APP_ARCHIVE_NAME" \
    || die "download failed"

  # Do not run an application archive that could not be checked.
  curl -fsSL --retry 2 -o "$CHECKSUM_FILE" "$BASE_URL/SHASUMS256.txt" \
    || { rm -f "$APP_ARCHIVE"; die "could not download the application checksum list"; }
fi

EXPECTED=$(awk -v f="$APP_ARCHIVE_NAME" '$2 == f { print $1; exit }' "$CHECKSUM_FILE")
ACTUAL=$(sha256_of "$APP_ARCHIVE")
if [ -z "$EXPECTED" ] || [ -z "$ACTUAL" ]; then
  [ -n "$FROM" ] || rm -f "$APP_ARCHIVE" "$CHECKSUM_FILE"
  die "could not verify the application archive checksum"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  [ -n "$FROM" ] || rm -f "$APP_ARCHIVE" "$CHECKSUM_FILE"
  die "checksum mismatch for the application archive"
fi
say "application checksum verified"
[ -n "$FROM" ] || rm -f "$CHECKSUM_FILE"

rm -rf "$APP_DIR" "$INSTALL_DIR/.unpack"
mkdir -p "$INSTALL_DIR/.unpack"
tar -xzf "$APP_ARCHIVE" -C "$INSTALL_DIR/.unpack" 2>/dev/null \
  || { rm -rf "$INSTALL_DIR/.unpack"; mkdir -p "$INSTALL_DIR/.unpack"; unzip -q "$APP_ARCHIVE" -d "$INSTALL_DIR/.unpack" 2>/dev/null; } \
  || die "the archive could not be unpacked: $APP_ARCHIVE"
mv "$INSTALL_DIR/.unpack/app" "$APP_DIR"
rm -rf "$INSTALL_DIR/.unpack"
[ "$APP_ARCHIVE" = "$INSTALL_DIR/velatura-app.tar.gz" ] && rm -f "$INSTALL_DIR/velatura-app.tar.gz"
say "installed in $APP_DIR"

# --------------------------------------------------------------- launcher ----
step "3/4  The velatura command"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/velatura"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
export VELATURA_CONFIG_DIR="$INSTALL_DIR"
exec "$NODE_BIN" "$APP_DIR/dist/velatura.js" "\$@"
EOF
chmod +x "$LAUNCHER"

# add it to the PATH, once
SHELL_RC=""
case "${SHELL:-}" in
  */zsh) SHELL_RC="$HOME/.zprofile" ;;
  */bash) SHELL_RC="$HOME/.bashrc" ;;
  *) [ -f "$HOME/.zprofile" ] && SHELL_RC="$HOME/.zprofile" || SHELL_RC="$HOME/.profile" ;;
esac
if [ -n "$SHELL_RC" ] && ! grep -q "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
  touch "$SHELL_RC"
  printf '\n# Velatura\nexport PATH="$PATH:%s"\n' "$BIN_DIR" >> "$SHELL_RC"
  say "added $BIN_DIR to the PATH in $SHELL_RC"
  say "open a new terminal (or restart this one) for it to take effect"
else
  say "the command is in $BIN_DIR"
fi

# a desktop entry, for the people who do not use the terminal
DESKTOP_DIR="$HOME/.local/share/applications"
if mkdir -p "$DESKTOP_DIR" 2>/dev/null; then
  cat > "$DESKTOP_DIR/velatura.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Velatura
Comment=Velatura
Exec=$LAUNCHER serve
Icon=applications-graphics
Terminal=false
Categories=Graphics;
EOF
  chmod +x "$DESKTOP_DIR/velatura.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  say "a shortcut is in the applications menu"
fi

# ----------------------------------------------------------------- engine ----
step "4/4  SD.Next"

ENGINE_FOUND=""
for candidate in \
  "$HOME/sdnext" "$HOME/SD.Next" "$HOME/sdnext/sdnext" \
  "$HOME/Documents/sdnext" "$HOME/Documents/SD.Next" \
  "$HOME/Desktop/sdnext" "$HOME/AI/sdnext" "$HOME/ComfyUI/sdnext" \
  "$HOME/Applications/sdnext" "$HOME/Applications/SD.Next" \
  "/Applications/sdnext" "/Applications/SD.Next" \
  "/opt/sdnext" "/opt/SD.Next" "/srv/sdnext"; do
  if [ -f "$candidate/webui.sh" ] && [ -f "$candidate/launch.py" ]; then
    ENGINE_FOUND="$candidate"
    break
  fi
done

if [ -n "$ENGINE_FOUND" ]; then
  say "found a likely SD.Next checkout at $ENGINE_FOUND (webui.sh and launch.py found)"
  say "the setup wizard will check this folder before Velatura saves it"
else
  say "no SD.Next startup script was found in the usual locations"
  say "the setup wizard will let you enter a folder and check it, or install SD.Next in your user folder"
fi
say "this installer does not install SD.Next or download model weights by itself"
say "the setup wizard checks Git and Python, then asks before it clones or starts SD.Next"

# ----------------------------------------------------------------- launch ----
step "Done"
say "Start Velatura with:   velatura"
say "It opens in your browser at http://127.0.0.1:7865"

if [ "$LAUNCH" = "1" ] && [ "$ASSUME_YES" = "0" ]; then
  if [ -r /dev/tty ]; then
    printf '\n  Start it now? [Y/n] '
    if read -r answer < /dev/tty; then
      case "$answer" in
        n|N|no) say "ok — run 'velatura' when you are ready" ;;
        *) "$LAUNCHER" serve ;;
      esac
    else
      say "ok — run 'velatura' when you are ready"
    fi
  else
    say "ok — run 'velatura' when you are ready"
  fi
elif [ "$LAUNCH" = "1" ]; then
  "$LAUNCHER" serve &
fi

exit 0
