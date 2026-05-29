#!/usr/bin/env python3
"""Audit Claude Code sessions against the working-methodology tier rules.

Reads JSONL transcripts at
    ~/.claude/projects/-Users-eliogovea-Project-baseball-limits-2d/*.jsonl
and reports, per session: declared tier, models used, subagents spawned,
tokens, optional $ cost via an external pricing file, and tier-compliance.

Pricing is intentionally not hardcoded — pass --pricing path/to/prices.json
with current values from Anthropic's pricing page. See
scripts/methodology_pricing.example.json for the schema.
"""
import argparse
import collections
import datetime as _dt
import json
import pathlib
import re
import sys

TRANSCRIPT_DIR = (
    pathlib.Path.home()
    / ".claude/projects/-Users-eliogovea-Project-baseball-limits-2d"
)
TIER_RE = re.compile(r"^\s*Tier:\s*(T[0-4])\b", re.MULTILINE)
AT_MENTION_RE = re.compile(r'@"([^"]+) \(agent\)"')
MODEL_SUFFIX_RE = re.compile(r"-\d{8}$")
USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


def _normalize(model):
    if not model:
        return None
    return MODEL_SUFFIX_RE.sub("", model)


def _extract_text(entry):
    msg = entry.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text", ""))
            elif isinstance(c, str):
                parts.append(c)
        return "\n".join(parts)
    return ""


def parse_session(path):
    tier = None
    first_user_text = None
    models = collections.Counter()
    usage = collections.defaultdict(lambda: collections.Counter())
    agents = []
    first_ts = last_ts = None
    entrypoint = None

    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            entrypoint = entrypoint or d.get("entrypoint")
            ts = d.get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts
            if d.get("type") == "user" and first_user_text is None:
                text = _extract_text(d)
                if text:
                    first_user_text = text
                    m = TIER_RE.search(text)
                    if m:
                        tier = m.group(1)
            if d.get("type") == "assistant":
                msg = d.get("message") or {}
                model = _normalize(msg.get("model"))
                if model:
                    models[model] += 1
                u = msg.get("usage") or {}
                for k in USAGE_KEYS:
                    v = u.get(k) or 0
                    usage[model][k] += v
                for c in msg.get("content") or []:
                    if (
                        isinstance(c, dict)
                        and c.get("type") == "tool_use"
                        and c.get("name") == "Agent"
                    ):
                        inp = c.get("input") or {}
                        agents.append({
                            "subagent_type": inp.get("subagent_type", "general-purpose"),
                            "model_override": inp.get("model"),
                            "isolation": inp.get("isolation"),
                        })

    return {
        "session_id": path.stem,
        "tier": tier,
        "first_user_text": first_user_text or "",
        "models": dict(models),
        "usage": {m: dict(c) for m, c in usage.items()},
        "agents": agents,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "entrypoint": entrypoint,
    }


def cost(usage_by_model, pricing):
    total = 0.0
    for model, u in usage_by_model.items():
        p = pricing.get(_normalize(model))
        if not p:
            continue
        total += u.get("input_tokens", 0) * p.get("input_per_mtok", 0) / 1_000_000
        total += u.get("output_tokens", 0) * p.get("output_per_mtok", 0) / 1_000_000
        total += (
            u.get("cache_read_input_tokens", 0)
            * p.get("cache_read_per_mtok", 0)
            / 1_000_000
        )
        total += (
            u.get("cache_creation_input_tokens", 0)
            * p.get("cache_write_per_mtok", 0)
            / 1_000_000
        )
    return total


def counterfactual_opus(usage_by_model, pricing):
    summed = collections.Counter()
    for u in usage_by_model.values():
        for k, v in u.items():
            summed[k] += v
    return cost({"claude-opus-4-7": dict(summed)}, pricing)


def compliance(rep, meta=None):
    """Return (status, reason). status is True, False, or None (skipped).

    If `meta` (per-pilot side-channel) is provided, it overrides heuristic
    intent detection — e.g. `session_agent: "Plan"` is treated as equivalent
    to an @"Plan (agent)" in the opening prompt.
    """
    meta = meta or {}
    tier = meta.get("tier") or rep["tier"]
    if tier is None:
        return (None, "untagged — skipped")
    if not rep["models"]:
        return (False, "no assistant messages — empty session")
    main = max(rep["models"], key=rep["models"].get)
    n_agents = len(rep["agents"])
    plan_agents = [a for a in rep["agents"] if a["subagent_type"] == "Plan"]
    opus_plans = [a for a in plan_agents if a["model_override"] == "opus"]
    mentioned = set(AT_MENTION_RE.findall(rep["first_user_text"]))
    intent_plan = "Plan" in mentioned or meta.get("session_agent") == "Plan"
    session_agent_plan = meta.get("session_agent") == "Plan"
    worktree = any(a.get("isolation") == "worktree" for a in rep["agents"])

    if tier == "T0":
        ok = n_agents == 0 and "haiku" in main
        return (ok, f"main={main} agents={n_agents}")
    if tier == "T1":
        ok = n_agents <= 1 and "sonnet" in main
        return (ok, f"main={main} agents={n_agents}")
    if tier == "T2":
        ok = intent_plan and (session_agent_plan or len(plan_agents) >= 1) and "sonnet" in main
        return (ok, f"main={main} @Plan={intent_plan} plans={len(plan_agents)} sess_agent={meta.get('session_agent')}")
    if tier == "T3":
        # Effect can be either: a Plan subagent call with model=opus, OR session-wide --agent Plan + main=opus.
        effect_ok = len(opus_plans) >= 1 or (session_agent_plan and "opus" in main)
        ok = intent_plan and effect_ok and "opus" in main
        return (
            ok,
            f"main={main} @Plan={intent_plan} opus_plans={len(opus_plans)} sess_agent={meta.get('session_agent')}",
        )
    if tier == "T4":
        effect_ok = len(opus_plans) >= 1 or (session_agent_plan and "opus" in main)
        ok = intent_plan and effect_ok and "opus" in main and worktree
        return (
            ok,
            f"main={main} @Plan={intent_plan} opus_plans={len(opus_plans)} sess_agent={meta.get('session_agent')} worktree={worktree}",
        )
    return (None, f"unknown tier {tier}")


def _summary_line(rep, pricing, meta=None):
    text = rep["first_user_text"].splitlines()[0] if rep["first_user_text"] else ""
    text = text[:80].replace("`", "")
    tier = (meta or {}).get("tier") or rep["tier"] or "—"
    models = ", ".join(sorted(rep["models"])) or "—"
    agent_summary = collections.Counter(
        (a["subagent_type"], a["model_override"] or "default") for a in rep["agents"]
    )
    agent_str = (
        ", ".join(f"{st}×{n} (model:{m})" for (st, m), n in agent_summary.items())
        or "none"
    )
    usage_total = collections.Counter()
    for u in rep["usage"].values():
        for k, v in u.items():
            usage_total[k] += v
    tokens = (
        f"in {usage_total['input_tokens']:,} / out {usage_total['output_tokens']:,} / "
        f"cache_r {usage_total['cache_read_input_tokens']:,} / "
        f"cache_w {usage_total['cache_creation_input_tokens']:,}"
    )
    actual = cost(rep["usage"], pricing) if pricing else None
    cf = counterfactual_opus(rep["usage"], pricing) if pricing else None
    cost_str = ""
    if pricing:
        savings = ((cf - actual) / cf * 100.0) if cf > 0 else 0.0
        cost_str = f"  cost ${actual:.4f}  all-opus ${cf:.4f}  savings {savings:.1f}%"
    status, reason = compliance(rep, meta)
    label = "PASS" if status is True else ("FAIL" if status is False else "SKIP")
    sess_agent = (meta or {}).get("session_agent")
    sess_agent_str = f"  session_agent: {sess_agent}\n" if sess_agent else ""
    return (
        f"session {rep['session_id'][:8]}  tier={tier}  models=[{models}]\n"
        f"  prompt: {text!r}\n"
        f"  agents: {agent_str}\n"
        f"{sess_agent_str}"
        f"  tokens: {tokens}{cost_str}\n"
        f"  compliance: {label} ({reason})"
    )


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Audit Claude Code sessions against tiered-methodology rules."
    )
    p.add_argument("--since", help="ISO date YYYY-MM-DD; only sessions with last_ts >= this")
    p.add_argument("--session", action="append", default=[], help="Restrict to these session IDs (substring match; repeatable)")
    p.add_argument("--pricing", help="Path to pricing JSON (see scripts/methodology_pricing.example.json)")
    p.add_argument("--pilot-meta", help="Directory of per-pilot meta JSON files written by run_methodology_pilot.sh")
    p.add_argument(
        "--transcript-dir",
        default=str(TRANSCRIPT_DIR),
        help=f"Directory of *.jsonl transcripts (default: {TRANSCRIPT_DIR})",
    )
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON instead of text")
    args = p.parse_args(argv)

    pricing = None
    if args.pricing:
        with open(args.pricing) as fh:
            pricing = json.load(fh)

    meta_by_sid = {}
    if args.pilot_meta:
        mdir = pathlib.Path(args.pilot_meta)
        for mpath in sorted(mdir.glob("*.meta.json")):
            try:
                with mpath.open() as fh:
                    m = json.load(fh)
            except (json.JSONDecodeError, OSError):
                continue
            sid = m.get("session_id")
            if sid:
                meta_by_sid[sid] = m

    tdir = pathlib.Path(args.transcript_dir)
    if not tdir.is_dir():
        print(f"transcript dir not found: {tdir}", file=sys.stderr)
        return 1
    since = None
    if args.since:
        since = _dt.datetime.fromisoformat(args.since)

    reports = []
    for path in sorted(tdir.glob("*.jsonl")):
        if args.session and not any(s in path.stem for s in args.session):
            continue
        rep = parse_session(path)
        if since and rep["last_ts"]:
            try:
                last = _dt.datetime.fromisoformat(rep["last_ts"].rstrip("Z"))
            except ValueError:
                last = None
            if last and last < since:
                continue
        reports.append(rep)

    if args.json:
        out = []
        for rep in reports:
            meta = meta_by_sid.get(rep["session_id"])
            status, reason = compliance(rep, meta)
            out.append({
                **rep,
                "meta": meta,
                "compliance": {"status": status, "reason": reason},
                "cost_actual": cost(rep["usage"], pricing) if pricing else None,
                "cost_counterfactual_opus": counterfactual_opus(rep["usage"], pricing) if pricing else None,
            })
        print(json.dumps(out, indent=2, default=str))
        return 0

    passes = fails = skips = 0
    total_actual = total_cf = 0.0
    for rep in reports:
        meta = meta_by_sid.get(rep["session_id"])
        print(_summary_line(rep, pricing, meta))
        print()
        status, _ = compliance(rep, meta)
        if status is True:
            passes += 1
        elif status is False:
            fails += 1
        else:
            skips += 1
        if pricing:
            total_actual += cost(rep["usage"], pricing)
            total_cf += counterfactual_opus(rep["usage"], pricing)

    print("=" * 60)
    print(f"sessions: {len(reports)}  PASS={passes}  FAIL={fails}  SKIP={skips}")
    if pricing and total_cf > 0:
        savings = (total_cf - total_actual) / total_cf * 100.0
        print(
            f"aggregate cost: ${total_actual:.4f}  "
            f"all-opus counterfactual: ${total_cf:.4f}  "
            f"savings: {savings:.1f}%"
        )
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
