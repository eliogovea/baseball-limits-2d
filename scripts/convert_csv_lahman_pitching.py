"""Convert Lahman Pitching.csv + People.csv into the canonical pitching CSV.

Paralleling convert_csv_lahman.py for the batting side: rewrite playerID
from the Lahman opaque key to "<nameFirst> <nameLast>" (matching the rest
of the pipeline), drop the `stint` column (build_bundle.py aggregates by
player-year on the way into the binary), and keep the rest of the columns
intact.

Usage:
  python3 scripts/convert_csv_lahman_pitching.py \\
    data/people_lahman_1871-2025.csv \\
    data/pitching_lahman_1871-2025.csv \\
    data/pitching_limits_1871-2025.csv
"""

import csv
import argparse


PITCHING_FIELDS = [
    "playerID", "yearID", "teamID", "lgID",
    "W", "L", "G", "GS", "CG", "SHO", "SV",
    "IPouts", "H", "ER", "HR", "BB", "SO",
    "BAOpp", "ERA",
    "IBB", "WP", "HBP", "BK", "BFP", "GF",
    "R", "SH", "SF", "GIDP",
]


def convert(csv_people, csv_pitching, csv_output):
    people = {}
    # utf-8-sig handles the BOM on the People.csv header in the 2025 release.
    with open(csv_people, mode="r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            people[row["playerID"]] = row

    rows_out = []
    with open(csv_pitching, mode="r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            person = people.get(row["playerID"])
            if person is None:
                # Skip the rare pitching row whose playerID has no people
                # entry — same defensive behavior as the batting converter
                # (those rows would have an unjoinable name anyway).
                continue
            display_name = "{} {}".format(person["nameFirst"], person["nameLast"])
            out = {f: row.get(f, "") for f in PITCHING_FIELDS}
            out["playerID"] = display_name
            rows_out.append(out)

    with open(csv_output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=PITCHING_FIELDS)
        writer.writeheader()
        writer.writerows(rows_out)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("csv_people")
    p.add_argument("csv_pitching")
    p.add_argument("csv_output")
    args = p.parse_args()
    convert(args.csv_people, args.csv_pitching, args.csv_output)
    print(f"Wrote {args.csv_output}")
