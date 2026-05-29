#!/bin/bash
# Run the methodology validation pilots end-to-end via `claude -p` in isolated
# git worktrees. Each pilot starts from a clean baseline, runs non-interactively,
# and writes a side-channel meta file the audit script can use for compliance.
#
# Usage:
#   ./scripts/run_methodology_pilot.sh                # dry-run: print commands
#   ./scripts/run_methodology_pilot.sh --execute      # actually spend tokens
#   ./scripts/run_methodology_pilot.sh --cleanup      # remove pilot worktrees + results
#   ./scripts/run_methodology_pilot.sh --baseline <ref>  # baseline ref (default: HEAD)
#
# Environment:
#   PILOT_PRICING  — path to pricing JSON (default: ~/.claude/pricing.json)
#
# Output layout:
#   .pilot-worktrees/pilot-<N>-<label>/   # isolated git worktree per pilot
#   .pilot-results/pilot-<N>.meta.json    # what the runner declared (tier, model, session-agent)
#   .pilot-results/pilot-<N>.stdout.json  # raw `claude -p --output-format json` output

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_DIR="$REPO_ROOT/.pilot-worktrees"
RESULTS_DIR="$REPO_ROOT/.pilot-results"
PRICING="${PILOT_PRICING:-$HOME/.claude/pricing.json}"
BASELINE="HEAD"
EXECUTE=false
CLEANUP=false

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --execute) EXECUTE=true; shift ;;
        --cleanup) CLEANUP=true; shift ;;
        --baseline) BASELINE="$2"; shift 2 ;;
        -h|--help) usage 0 ;;
        *) echo "unknown flag: $1" >&2; usage 1 ;;
    esac
done

if [ "$CLEANUP" = true ]; then
    cd "$REPO_ROOT"
    if [ -d "$WORKTREE_DIR" ]; then
        for wt in "$WORKTREE_DIR"/pilot-*; do
            [ -d "$wt" ] && git worktree remove --force "$wt" 2>/dev/null || true
        done
        rmdir "$WORKTREE_DIR" 2>/dev/null || true
    fi
    # Delete pilot branches created by the runner
    git branch --list 'pilot-*-runner' --format '%(refname:short)' | while read -r br; do
        [ -n "$br" ] && git branch -D "$br" 2>/dev/null || true
    done
    rm -rf "$RESULTS_DIR"
    echo "removed pilot worktrees, branches, and results"
    exit 0
fi

cd "$REPO_ROOT"
BASELINE_SHA=$(git rev-parse --verify "$BASELINE" 2>/dev/null || true)
if [ -z "$BASELINE_SHA" ]; then
    echo "error: baseline ref '$BASELINE' not found" >&2
    exit 1
fi

# Sanity: does the baseline contain the Working methodology section in CLAUDE.md?
if ! git show "$BASELINE_SHA":CLAUDE.md 2>/dev/null | grep -q "Working methodology"; then
    echo "WARNING: '$BASELINE' (${BASELINE_SHA:0:8}) does not contain the 'Working methodology' section in CLAUDE.md." >&2
    echo "         Pilots will run without the methodology baked in, so Claude won't know about tiers." >&2
    echo "         Commit the methodology section first, then re-run." >&2
    echo "" >&2
fi

mkdir -p "$WORKTREE_DIR" "$RESULTS_DIR"

# Pilot definitions: tier|label|model|session_agent|prompt
#   session_agent="none" means no --agent flag (relies on natural-language or assistant judgment)
#   session_agent="Plan" passes --agent Plan to make the whole session run as Plan (guaranteed)
PILOTS=(
    "T0|dark-mode|haiku|none|Tier: T0 — add dark mode via a prefers-color-scheme: dark CSS block."
    "T1|glossary-tooltip|sonnet|none|Tier: T1 — hover the X/Y axis label to show the glossary blurb for that stat. Reuse the existing glossary content."
    "T3|pareto-depth-design|opus|Plan|Tier: T3 — design Pareto onion-peeling for layers 1–5 in script.js. Design only (no implementation). Cover recursive sweep, layered rendering, UI toggle, URL-hash state, and the algorithmic invariants the implementer should assert. Stay under 600 words."
)

run_pilot() {
    local idx="$1" tier="$2" label="$3" model="$4" agent="$5" prompt="$6"
    local wt="$WORKTREE_DIR/pilot-${idx}-${label}"
    local meta_file="$RESULTS_DIR/pilot-${idx}.meta.json"
    local out_file="$RESULTS_DIR/pilot-${idx}.stdout.json"
    local branch="pilot-${idx}-${label}-runner"

    echo
    echo "=== Pilot ${idx}: ${tier} — ${label} ==="
    echo "  worktree: ${wt#$REPO_ROOT/}"
    echo "  model:    $model"
    if [ "$agent" != "none" ]; then
        echo "  agent:    $agent (session-wide --agent flag)"
    fi
    echo "  prompt:   $prompt"

    # Compose the claude -p command
    local claude_cmd=("claude" "-p" "$prompt" "--model" "$model" "--permission-mode" "acceptEdits" "--output-format" "json")
    if [ "$agent" != "none" ]; then
        claude_cmd+=("--agent" "$agent")
    fi

    if [ "$EXECUTE" = false ]; then
        printf "  command:  "
        printf '%q ' "${claude_cmd[@]}"
        printf '\n'
        echo "  (dry-run — not executed)"
        return 0
    fi

    # Create the worktree off the baseline SHA
    if [ -d "$wt" ]; then
        echo "  worktree exists; reusing (delete with --cleanup to start fresh)"
    else
        git worktree add -B "$branch" "$wt" "$BASELINE_SHA" >/dev/null
    fi

    # Run claude -p inside the worktree
    local started
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    (cd "$wt" && "${claude_cmd[@]}") > "$out_file" 2>&1 || {
        echo "  FAILED — see $out_file"
        # Still write meta so audit can flag the pilot
        printf '{"pilot": %d, "tier": "%s", "label": "%s", "main_model_flag": "%s", "session_agent": %s, "opening_prompt": %s, "started": "%s", "status": "failed"}\n' \
            "$idx" "$tier" "$label" "$model" \
            "$([ "$agent" = "none" ] && echo null || printf '"%s"' "$agent")" \
            "$(printf '%s' "$prompt" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
            "$started" > "$meta_file"
        return 1
    }

    # Extract session_id and cost from claude's JSON output
    local session_id cost
    session_id=$(python3 -c "import json,sys; d=json.load(open('$out_file')); print(d.get('session_id',''))" 2>/dev/null || true)
    cost=$(python3 -c "import json,sys; d=json.load(open('$out_file')); print(d.get('total_cost_usd', 0))" 2>/dev/null || echo 0)

    # Write meta side-channel for the audit script
    python3 - "$meta_file" "$idx" "$tier" "$label" "$model" "$agent" "$prompt" "$session_id" "$started" "$cost" <<'PY'
import json, sys
meta_file, idx, tier, label, model, agent, prompt, session_id, started, cost = sys.argv[1:]
meta = {
    "pilot": int(idx),
    "tier": tier,
    "label": label,
    "main_model_flag": model,
    "session_agent": None if agent == "none" else agent,
    "opening_prompt": prompt,
    "session_id": session_id,
    "started": started,
    "claude_p_cost_usd": float(cost) if cost else 0.0,
}
with open(meta_file, "w") as fh:
    json.dump(meta, fh, indent=2)
PY

    echo "  session:  ${session_id:-<missing>}"
    echo "  cost:     \$${cost}"
}

# Run each pilot
idx=1
failures=0
for spec in "${PILOTS[@]}"; do
    IFS='|' read -r tier label model agent prompt <<< "$spec"
    run_pilot "$idx" "$tier" "$label" "$model" "$agent" "$prompt" || failures=$((failures + 1))
    idx=$((idx + 1))
done

if [ "$EXECUTE" = false ]; then
    echo
    echo "=== Dry-run complete ==="
    echo "No worktrees created, no tokens spent."
    echo "Re-run with --execute to actually run the pilots."
    exit 0
fi

# Run audit on the just-collected sessions
echo
echo "=== Audit ==="
session_args=()
for mf in "$RESULTS_DIR"/pilot-*.meta.json; do
    [ -f "$mf" ] || continue
    sid=$(python3 -c "import json,sys; d=json.load(open('$mf')); print(d.get('session_id',''))")
    [ -n "$sid" ] && session_args+=("--session" "$sid")
done

audit_cmd=(python3 "$REPO_ROOT/scripts/methodology_audit.py" "${session_args[@]}" --pilot-meta "$RESULTS_DIR")
[ -f "$PRICING" ] && audit_cmd+=("--pricing" "$PRICING")
"${audit_cmd[@]}"

echo
echo "Pilot worktrees left under .pilot-worktrees/ for inspection (git diff inside each)."
echo "Run '$0 --cleanup' to remove them."
exit "$failures"
