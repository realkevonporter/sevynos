#!/usr/bin/env python3
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
old = """for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });"""
new = """__getOwnPropNames(from).forEach((key) => {
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      });"""
if old not in source:
    raise SystemExit("Hermes bundle interoperability helper was not found")
path.write_text(source.replace(old, new, 1))
