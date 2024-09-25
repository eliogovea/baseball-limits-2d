import csv
import argparse

def convert_csv_lahman(csv_people, csv_batting, csv_output):
    csv_people_data = {}
    with open(csv_people, mode='r', encoding='utf-8') as csv_file:
        csv_reader = csv.DictReader(csv_file)
        for row in csv_reader:
            csv_people_data[row["playerID"]] = row

    csv_batting_rows = []
    with open(csv_batting, mode='r', encoding='utf-8') as csv_file:
        csv_reader = csv.DictReader(csv_file)
        for row in csv_reader:
            csv_batting_rows.append({
                "playerID": "{} {}".format(csv_people_data[row["playerID"]]["nameFirst"], csv_people_data[row["playerID"]]["nameLast"]),
                "yearID": row["yearID"],
                "teamID": row["teamID"],
                "lgID": row["lgID"],
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

    with open(csv_output, 'w', newline='') as csv_file:
        fieldnames = ["playerID","yearID","teamID","lgID","G","AB","R","H","2B","3B","HR","RBI","SB","CS","BB","SO","IBB","HBP","SH","SF","GIDP"]
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rowdicts=csv_batting_rows)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Convert CSV file to JSON format.')
    parser.add_argument('csv_people', type=str, help='Input people file')
    parser.add_argument('csv_batting', type=str, help='Input batting file')
    parser.add_argument('csv_output', type=str, help='Output batting file')
    args = parser.parse_args()

    convert_csv_lahman(args.csv_people, args.csv_batting, args.csv_output)
    print(f"Converted {args.csv_people} and {args.csv_batting} to {args.csv_output}")
