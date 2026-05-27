"""Shared helper: pick a unique display name per Lahman playerID.

Both the batting and the pitching converters use this to avoid conflating
players with the same '<first> <last>' string (Frank Thomas the Big Hurt
vs. the older Frank Thomases; Ken Griffey Sr. vs. Jr.; etc.). Plain
'first last' collides for ~568 of Lahman's ~24,000 player names; the
display function appends a birth-year tag only for those collisions
so most names render exactly the same as before.
"""

import csv


def build_display_name_map(csv_people_path):
    """Read a Lahman People.csv and return dict[lahman_playerID -> display_name].

    Single-player names are unchanged. Names shared by multiple Lahman
    playerIDs get a "(b.YYYY)" suffix; if a player has no birth year,
    falls back to "(playerID)" so the result is still deterministic.
    """
    rows = []
    with open(csv_people_path, mode="r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append(row)

    by_name = {}
    for row in rows:
        plain = "{} {}".format(row["nameFirst"], row["nameLast"])
        by_name.setdefault(plain, []).append(row)

    display = {}
    for plain, group in by_name.items():
        if len(group) == 1:
            display[group[0]["playerID"]] = plain
            continue
        for row in group:
            birth = (row.get("birthYear") or "").strip()
            if birth and birth.isdigit():
                tag = "b." + birth
            else:
                tag = row["playerID"]
            display[row["playerID"]] = f"{plain} ({tag})"
    return display
