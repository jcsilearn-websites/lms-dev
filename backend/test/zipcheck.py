# Independent check of a generated archive: Python's own zipfile (not our code) reads it, verifies every CRC and
# prints "name sha256" per entry as JSON. Used by core/__tests__/zip.unit.test.ts.
import hashlib
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    if bad is not None:
        print(json.dumps({"error": "bad crc: " + bad}))
        sys.exit(1)
    out = {}
    for info in z.infolist():
        out[info.filename] = {
            "sha256": hashlib.sha256(z.read(info)).hexdigest(),
            "size": info.file_size,
            "zip64": info.extract_version >= 45,
        }
    print(json.dumps(out))
