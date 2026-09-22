#!/usr/bin/env python3
"""Mechanically rename the upstream NET contracts to MOASS, reference/src -> src.

Identifier-boundary replacement only: `mainnet` and the attribution word `NetNet`
in comments are deliberately left intact. Run from contracts/.
Re-runnable: wipes and regenerates src/ from reference/src each time.
"""
import os, re, shutil, sys

REF, OUT = "reference/src", "src"

# Whole-identifier renames. Boundaries are enforced, so order does not matter.
IDENTS = {
    "StakedNET": "StakedMOASS", "INET": "IMOASS", "IsNET": "IsMOASS",
    "NET_UNIT": "MOASS_UNIT", "NET": "MOASS", "net": "moass", "net_": "moass_", "_net": "_moass",
    "sNET": "sMOASS", "sNet": "sMoass", "sNet_": "sMoass_", "_sendSNet": "_sendSMoass",
    "netAmount": "moassAmount", "netSold": "moassSold", "netReserve": "moassReserve",
    "netR": "moassR", "netIn": "moassIn", "netMinted": "moassMinted",
    "netBurned": "moassBurned", "netDecimals": "moassDecimals", "netForPol": "moassForPol",
    "netIsToken0": "moassIsToken0", "_netIsToken0": "_moassIsToken0",
    "mintNet": "mintMoass", "pendingNet": "pendingMoass", "claimedNet": "claimedMoass",
    "purchasedNetOf": "purchasedMoassOf", "claimableNetOf": "claimableMoassOf",
    "twapNetUsdg": "twapMoassUsdg", "payoutPerNET": "payoutPerMOASS",
    "NetMinted": "MoassMinted", "NotANetPool": "NotAMoassPool",
}

# Brand strings, applied before identifiers so the quoted text wins.
STRINGS = [
    ('"NetNet Founding Shareholder Certificate"', '"Moass Fund Founding Shareholder Certificate"'),
    ('"NET-FS"', '"MOASS-FS"'),
    ('"Staked NET"', '"Staked MOASS"'),
    ('"NetNet"', '"Moass Fund"'),
    ('"sNET"', '"sMOASS"'),
    ('"NET"', '"MOASS"'),
    ('"./interfaces/INET.sol"', '"./interfaces/IMOASS.sol"'),
    ('"./interfaces/IsNET.sol"', '"./interfaces/IsMOASS.sol"'),
    ('"./INET.sol"', '"./IMOASS.sol"'),
    ('"./IsNET.sol"', '"./IsMOASS.sol"'),
]

FILES = {
    "NET.sol": "MOASS.sol", "StakedNET.sol": "StakedMOASS.sol",
    "interfaces/INET.sol": "interfaces/IMOASS.sol", "interfaces/IsNET.sol": "interfaces/IsMOASS.sol",
}

HEADER = ("// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for\n"
          "// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.\n")

PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(" + "|".join(sorted(map(re.escape, IDENTS), key=len, reverse=True)) + r")(?![A-Za-z0-9_])")


def convert(text):
    for a, b in STRINGS:
        text = text.replace(a, b)
    text = PATTERN.sub(lambda m: IDENTS[m.group(1)], text)
    # Re-insert the fork notice directly under the SPDX line.
    lines = text.split("\n")
    if lines and lines[0].startswith("// SPDX"):
        lines.insert(1, HEADER.rstrip("\n"))
    return "\n".join(lines)


def main():
    if not os.path.isdir(REF):
        sys.exit("run from contracts/ (no %s)" % REF)
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    n = 0
    for root, _, names in os.walk(REF):
        for name in names:
            if not name.endswith(".sol"):
                continue
            rel = os.path.relpath(os.path.join(root, name), REF)
            dest_rel = FILES.get(rel, rel)
            dest = os.path.join(OUT, dest_rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(os.path.join(root, name)) as fh:
                body = fh.read()
            with open(dest, "w") as fh:
                fh.write(convert(body))
            n += 1
            if rel != dest_rel:
                print("  renamed %s -> %s" % (rel, dest_rel))
    print("%d files -> %s/" % (n, OUT))

    leftover = []
    for root, _, names in os.walk(OUT):
        for name in names:
            path = os.path.join(root, name)
            for i, line in enumerate(open(path), 1):
                if i > 2 and re.search(r"(?<![A-Za-z0-9_])(NET|net|sNET|INET|IsNET)(?![A-Za-z0-9_])", line):
                    leftover.append("%s:%d: %s" % (path, i, line.strip()[:100]))
    if leftover:
        print("\nWARNING: bare NET/net identifiers still present:")
        for l in leftover:
            print("  " + l)
    else:
        print("no bare NET/net identifiers remain")


if __name__ == "__main__":
    main()
