import csv
import json
import argparse

def convert_csv_bbref(csv_input_path, csv_output_path, year):
    rows = []

    with open(csv_input_path, mode='r', encoding='utf-8') as csv_file:
    
        csv_reader = csv.DictReader(csv_file)
    
        for row in csv_reader:
            print(row)
            rows.append({
                "playerID": row["Player"],
                "yearID": year,
                "teamID": row["Team"],
                "lgID": row["Lg"],
                "G": row["G"],
                "AB": row["AB"],
                "R": row["R"],
                "H": row["H"],
                "2B": row["2B"],
                "3B": row["3B"],
                "HR": row["HR"],
                "RBI": row["RBI"],
                "SB": row["SB"],
                "CS": row["CS"],
                "SO": row["SO"],
                "BB": row["BB"],
                "IBB": row["IBB"],
                "HBP": row["HBP"],
                "SH": row["SH"],
                "SF": row["SF"],
                "GIDP": row["GIDP"],
            })

    with open(csv_output_path, 'w', newline='') as csvfile:
        fieldnames = ["playerID","yearID","teamID","lgID","G","AB","R","H","2B","3B","HR","RBI","SB","CS","BB","SO","IBB","HBP","SH","SF","GIDP"]
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rowdicts=rows)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Convert CSV file to JSON format.')
    parser.add_argument('csv_input', type=str, help='Input CSV file path')
    parser.add_argument('csv_output', type=str, help='Output CSV file path')
    parser.add_argument('year', type=int, help='Year')
    args = parser.parse_args()

    convert_csv_bbref(args.csv_input, args.csv_output, args.year)
    print(f"Converted {args.csv_input} to {args.csv_output}")
