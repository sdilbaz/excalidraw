#!/usr/bin/env bash
# Watches the local processes behind the Excalidraw dev server and the MCP
# bridge for network connections to non-loopback addresses, and prints each new
# one. Complements the in-browser watcher, which covers the app tab.
#
# Usage: watch-egress.sh [port ...]   (default: 3001 3050)
# Env:   EGRESS_WATCH_INTERVAL seconds between polls (default 1)
#
# Limits: polling can miss connections shorter than the interval, and DNS
# lookups on macOS go through mDNSResponder, so they are not attributed here.

set -euo pipefail

if [[ $# -gt 0 ]]; then
  ports=("$@")
else
  ports=(3001 3050)
fi
interval="${EGRESS_WATCH_INTERVAL:-1}"
loopback_remote='->(127\.[0-9.]+|\[::1\]|localhost):'

# newline-separated sets (macOS ships bash 3.2, without associative arrays)
seen=""
announced_pids=""

contains_line() {
  grep -qxF -- "$2" <<<"$1"
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

log "watching processes listening on ports: ${ports[*]} (every ${interval}s)"

while true; do
  pids=()
  for port in "${ports[@]}"; do
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && pids+=("$pid")
    done < <(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  done

  if [[ ${#pids[@]} -gt 0 ]]; then
    pid_list=$(printf '%s\n' "${pids[@]}" | sort -u | paste -sd, -)
    for pid in ${pid_list//,/ }; do
      if ! contains_line "$announced_pids" "$pid"; then
        announced_pids+="$pid"$'\n'
        log "watching pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null || echo exited))"
      fi
    done

    # connected sockets have a "local->remote" NAME; listeners don't
    while IFS= read -r line; do
      if [[ "$line" == *"->"* ]] && ! [[ "$line" =~ $loopback_remote ]]; then
        key=$(awk '{print $2, $NF, $(NF-1)}' <<<"$line")
        if ! contains_line "$seen" "$key"; then
          seen+="$key"$'\n'
          log "NON-LOCAL CONNECTION: $line"
        fi
      fi
    done < <(lsof -nP -a -p "$pid_list" -i 2>/dev/null | tail -n +2 || true)
  fi

  sleep "$interval"
done
