#!/usr/bin/env python3
"""Prove src/ is a pure rename of reference/src/ and nothing more.

Bytecode cannot be compared directly: renaming a public function changes its
4-byte selector, which changes the dispatcher. The ABI can — apply the same
rename map to the upstream ABI and the two must be identical, entry for entry.

Run from contracts/, after `forge build` in both . and reference/.
"""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from rename_fork import IDENTS

PAIRS = [("MOASS","NET"),("StakedMOASS","StakedNET"),("Staking","Staking"),("Distributor","Distributor"),
         ("Treasury","Treasury"),("BondDepository","BondDepository"),("PairOracle","PairOracle"),
         ("TaxCollector","TaxCollector"),("GenesisBond","GenesisBond"),("InverseBond","InverseBond"),
         ("PremiumSeller","PremiumSeller"),("PTeam","PTeam"),("ShareCertificate","ShareCertificate")]

PAT = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(sorted(map(re.escape, IDENTS), key=len, reverse=True)) + r")(?![A-Za-z0-9_])")
ren = lambda s: PAT.sub(lambda m: IDENTS[m.group(1)], s) if isinstance(s, str) else s


def abi(base, name):
    return json.load(open(os.path.join(base, "out", name + ".sol", name + ".json")))["abi"]


def walk(x):
    if isinstance(x, dict):
        return {k: walk(ren(v) if k in ("name", "internalType") else v) for k, v in x.items()}
    if isinstance(x, list):
        return [walk(i) for i in x]
    return x


def canon(entries):
    return json.dumps(sorted(entries, key=lambda e: json.dumps(e, sort_keys=True)), sort_keys=True)


def main():
    print("%-18s %-8s %s" % ("CONTRACT", "ENTRIES", "ABI vs renamed-upstream ABI"))
    bad = 0
    for new, old in PAIRS:
        ours = abi(".", new)
        if canon(ours) == canon(walk(abi("reference", old))):
            verdict = "identical"
        else:
            verdict = "DIFFERS — the fork is no longer a pure rename"
            bad += 1
        print("%-18s %-8d %s" % (new, len(ours), verdict))
    print()
    if bad:
        print("%d contract(s) diverge. If that is intentional (step 3 onward), retire this check." % bad)
        sys.exit(1)
    print("all %d ABIs identical: src/ is a pure rename of reference/src/" % len(PAIRS))


if __name__ == "__main__":
    main()
