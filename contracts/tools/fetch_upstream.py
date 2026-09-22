#!/usr/bin/env python3
"""Vendor NetNet's Sourcify-verified sources into contracts/reference/.

Read-only against Sourcify; writes only under contracts/reference/ plus SOURCE.md.
Every file is recorded with the address it came from and its match type.
"""
import json, os, sys, urllib.request

CHAIN = 4663
OUT = "/home/magga_ws/projects/moass-fund/contracts/reference"
API = "https://sourcify.dev/server/v2/contract/%d/%s?fields=sources,compilation"

CONTRACTS = [
    ("NET",              "0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf"),
    ("StakedNET",        "0xb773ec2C326B7f98a5a83fc098825492F020a4c7"),
    ("Staking",          "0xB078cc304A0B264C5F3680DC0488954ACcd02E87"),
    ("Distributor",      "0x79e71F8a8a2912E40687a8820b2dC0fdd2f686b3"),
    ("Treasury",         "0x04822Ea321A0DEE6F40656172F29312104855d66"),
    ("BondDepository",   "0xff32a969A0c567129eECD926D04657728E1980C1"),
    ("PairOracle",       "0x929631b33F4070D6f54477fba3FD27566567dAca"),
    ("TaxCollector",     "0x086C58400b8708Ef993f256E12e752dcF0AC918e"),
    ("GenesisBond",      "0x575b7B7c97Ef3E21C82DAeB427899d583e1E913f"),
    ("InverseBond",      "0x92166e94Eea5B7799b761653881692f881dFC4C9"),
    ("PremiumSeller",    "0x346e1a31171A0f7aC73909010b5435768d3B5462"),
    ("PTeam",            "0x650F58079dAa17ee28928c2F92d22291d038B2B0"),
    ("ShareCertificate", "0xfB8058769063519f26FB114631919c0E5254068e"),
]


def fetch(addr):
    with urllib.request.urlopen(API % (CHAIN, addr), timeout=60) as r:
        return json.load(r)


def main():
    files = {}        # path -> content
    origin = {}       # path -> first contract that supplied it
    meta = []         # provenance rows
    conflicts = []

    for name, addr in CONTRACTS:
        try:
            d = fetch(addr)
        except Exception as e:
            print("FAIL %-18s %s: %s" % (name, addr, e))
            sys.exit(1)

        comp = d.get("compilation") or {}
        srcs = d.get("sources") or {}
        meta.append({
            "name": name,
            "onchain_name": comp.get("name"),
            "address": addr,
            "match": d.get("match"),
            "verifiedAt": d.get("verifiedAt"),
            "compiler": comp.get("compilerVersion"),
            "files": len(srcs),
        })

        for path, body in srcs.items():
            content = body.get("content")
            if path in files:
                if files[path] != content:
                    conflicts.append((path, origin[path], name))
                continue
            files[path] = content
            origin[path] = name

        print("ok   %-18s %-44s %s  %2d files" % (name, addr, d.get("match"), len(srcs)))

    if conflicts:
        print("\nCONTENT CONFLICTS (same path, different bytes):")
        for p, a, b in conflicts:
            print("  %s: %s vs %s" % (p, a, b))
        sys.exit(1)

    for path, content in sorted(files.items()):
        dest = os.path.join(OUT, path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as fh:
            fh.write(content)

    with open(os.path.join(OUT, "_provenance.json"), "w") as fh:
        json.dump({"chainId": CHAIN, "contracts": meta,
                   "files": {p: origin[p] for p in sorted(files)}}, fh, indent=2)

    print("\n%d unique source files -> %s" % (len(files), OUT))
    compilers = sorted({m["compiler"] for m in meta})
    print("compilers: %s" % ", ".join(compilers))
    print("matches:   %s" % ", ".join(sorted({m["match"] for m in meta})))


if __name__ == "__main__":
    main()
