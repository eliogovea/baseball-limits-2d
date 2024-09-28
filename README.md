# Baseball Limits 2D

## Overview

**[Baseball Limits 2D](https://eliogovea.github.io/baseball-limits-2d/)** aims to provide visualizations of players performance combining two parameters.

## Data Sources
- **[Lahman Database](http://seanlahman.com/)**: Statistics for MLB seasons up to 2023.
- **[Baseball Reference](https://www.baseball-reference.com/)**: Statistics for the 2024 MLB season.

## Update data
 - Download latest batting stats from [Baseball Reference](https://www.baseball-reference.com/leagues/majors/2024-standard-batting.shtml) to `data/batting_bbref_2024.csv`
 - Run the following scripts:
    ```console
    python3 scripts/convert_csv_bbref.py \
      data/batting_bbref_2024.csv \
      data/batting_limits_2024-2024.csv \
      2024
    ```
    ```console
    python3 scripts/combine_csv.py \
      data/batting_limits_1871-2023.csv \
      data/batting_limits_2024-2024.csv \
      data/batting_limits_1871-2024.csv 
    ```