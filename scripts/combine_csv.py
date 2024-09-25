import csv
import json
import argparse

def csv_combine(csv_input0, csv_input1, csv_output):
    with open(csv_input0, mode='r', encoding='utf-8') as csv_file:
        csv_reader = csv.DictReader(csv_file)
        cols0 = csv_reader.fieldnames
        rows0 = [row for row in csv_reader]
    
    with open(csv_input1, mode='r', encoding='utf-8') as csv_file:
        csv_reader = csv.DictReader(csv_file)
        cols1 = csv_reader.fieldnames
        rows1 = [row for row in csv_reader]
    

    with open(csv_output, 'w', newline='') as csv_file:
        print(cols0)
        print(cols1)
        assert cols0 == cols1
        writer = csv.DictWriter(csv_file, fieldnames=cols0)
        writer.writeheader()
        writer.writerows(rowdicts=rows0)
        writer.writerows(rowdicts=rows1)

if __name__ == "__main__":
    # Set up argument parsing
    parser = argparse.ArgumentParser(description='Convert CSV file to JSON format.')
    parser.add_argument('csv_input0', type=str, help='Input CSV file path (0)')
    parser.add_argument('csv_input1', type=str, help='Input CSV file path (1)')
    parser.add_argument('csv_output', type=str, help='Output CSV file path')
    args = parser.parse_args()

    # Call the conversion function
    csv_combine(args.csv_input0, args.csv_input1, args.csv_output)
    print(f"Merged {args.csv_input0} and {args.csv_input1} into {args.csv_output}")
