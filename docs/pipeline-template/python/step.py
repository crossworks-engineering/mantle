"""The step of the LX-9 template in Python (docs/pipelines.md, "Own pipelines").

The parser starts this file with the job's folder as its one argument. It
reads request.json and in.bin there, and writes result.json there: the same
status and calls as a Bun step. Standard library only; the parser's Python
also has the libraries of its venv. It asks no AI worker and calls no other
tool: the core writes the tabs.
"""
import json
import os
import sys


def read_lx9(text, max_rows):
    header, readings, cut = [], [], False
    for raw in text.splitlines()[1:]:
        line = raw.strip()
        if line == "" or line == "TIME;TAG;VALUE":
            continue
        if line.startswith("#"):
            at = line.find("=")
            if at > 1:
                header.append([line[1:at], line[at + 1:]])
            continue
        if len(readings) >= max_rows:
            cut = True
            break
        parts = (line.split(";") + ["", "", ""])[:3]
        try:
            value = float(parts[2]) if parts[2] != "" else None
        except ValueError:
            value = None
        readings.append([parts[0], parts[1], value, ""])
    unit = next((v for k, v in header if k == "UNIT"), "")
    for r in readings:
        r[3] = unit
    tags = list(dict.fromkeys(r[1] for r in readings))
    return header, readings, tags, unit, cut


def step(request, data):
    text = data.decode("utf-8", errors="replace")
    if not text.startswith("#LX9 "):
        return {"status": "not_mine"}
    max_rows = int(request.get("options", {}).get("max_rows", 200000))
    header, readings, tags, unit, cut = read_lx9(text, max_rows)
    col = lambda name, kind: {"name": name, "type": kind}
    return {
        "status": "ok",
        "warnings": [f"Only the first {len(readings)} readings were read."] if cut else [],
        "calls": [
            {
                "call": "tool",
                "tool": "file_tabs_write",
                "input": {
                    "tabs": [
                        {
                            "name": "Readings",
                            "columns": [col("Time", "text"), col("Tag", "text"),
                                        col("Value", "number"), col("Unit", "text")],
                            "rows": readings,
                        },
                        {
                            "name": "Header",
                            "columns": [col("Key", "text"), col("Value", "text")],
                            "rows": header,
                        },
                    ],
                    "description": f"LX-9 export: {len(tags)} tags, {len(readings)} readings, unit {unit or 'none'}.",
                },
            }
        ],
    }


def main():
    job = sys.argv[1]
    with open(os.path.join(job, "request.json"), encoding="utf-8") as f:
        request = json.load(f)
    with open(os.path.join(job, "in.bin"), "rb") as f:
        data = f.read()
    result = step(request, data)
    with open(os.path.join(job, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
