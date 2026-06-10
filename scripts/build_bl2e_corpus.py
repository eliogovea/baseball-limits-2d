"""Build the full BL2E event-level corpus, one season at a time (phase P4).

Downloads each season's Retrosheet parsed plays zip, converts it to
data/pbp/e<year>.bl2e.gz, and deletes the temp CSV. Idempotent/resumable: a year
whose output already exists is skipped (unless --force), so an interrupted run just
needs to be re-invoked. The people crosswalk is loaded once and reused across years.

    python3 scripts/build_bl2e_corpus.py              # 1903-2025, skip existing
    python3 scripts/build_bl2e_corpus.py 1920-1925    # a subrange
    python3 scripts/build_bl2e_corpus.py --no-pitches  # Layer A only
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_retrosheet_events import convert, build_retro_to_display, PEOPLE_PATH, OUT_DIR

URL = "https://www.retrosheet.org/downloads/plays/{year}plays.zip"


def fetch_season_csv(year, workdir):
    """Download + extract <year>plays.zip into workdir; return the CSV path or None."""
    url = URL.format(year=year)
    zip_path = workdir / f"{year}plays.zip"
    try:
        with urlopen(url, timeout=120) as resp, open(zip_path, "wb") as f:
            shutil.copyfileobj(resp, f)
    except (HTTPError, URLError) as e:
        print(f"  {year}: download failed ({e}) — skipping")
        return None
    try:
        with zipfile.ZipFile(zip_path) as z:
            name = next((n for n in z.namelist() if n.lower().endswith(".csv")), None)
            if not name:
                print(f"  {year}: no CSV in zip — skipping")
                return None
            z.extract(name, workdir)
            return workdir / name
    finally:
        zip_path.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser(description="Build the full BL2E corpus from Retrosheet season zips")
    ap.add_argument("years", nargs="?", default="1903-2025", help="year or START-END (default 1903-2025)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-pitches", action="store_true")
    ap.add_argument("--fielding", action="store_true", help="include Layer C fielding detail")
    args = ap.parse_args()

    out_dir = Path(args.out)
    if "-" in args.years:
        lo, hi = (int(x) for x in args.years.split("-", 1))
        years = range(lo, hi + 1)
    else:
        years = [int(args.years)]

    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    built = skipped = failed = 0
    total_bytes = 0
    for y in years:
        out_path = out_dir / f"e{y}.bl2e.gz"
        if out_path.exists() and not args.force:
            print(f"  {y}: exists — skipping")
            skipped += 1
            total_bytes += out_path.stat().st_size
            continue
        with tempfile.TemporaryDirectory() as td:
            csv_path = fetch_season_csv(y, Path(td))
            if csv_path is None:
                failed += 1
                continue
            stats = convert(str(csv_path), y, out_dir, retro_to_display,
                            force=args.force, include_pitches=not args.no_pitches,
                            include_fielding=args.fielding)
            if stats is None:
                failed += 1
            else:
                built += 1
                total_bytes += out_path.stat().st_size

    print(f"\nDONE: built {built}, skipped {skipped}, failed/empty {failed}. "
          f"Corpus total {total_bytes / 1048576:.1f} MB across {built + skipped} files.")


if __name__ == "__main__":
    main()
