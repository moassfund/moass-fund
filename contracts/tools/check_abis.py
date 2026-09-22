#!/usr/bin/env python3
"""Verify the front end's hand-written ABIs against the compiled artifacts.

`src/protocol/abis.ts` lists only the functions the UI touches, in viem's
human-readable form. That is easy to read in review but easy to get subtly
wrong — a renamed argument is harmless, a changed type is a silent runtime
failure that only shows up as a decode error in the browser.

This reads both sides and asserts every signature the front end declares exists
on the contract it claims to be calling, with matching input and output types.

Run from contracts/, after `forge build`.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ABIS_TS = os.path.join(os.path.dirname(ROOT), "src", "protocol", "abis.ts")
OUT = os.path.join(ROOT, "out")

# Which compiled contract each exported ABI is meant to describe. `pairAbi`
# targets an external Uniswap V2 pair, so it is checked against the mock that
# stands in for one in the test suite.
TARGETS = {
    "erc20Abi": "MOASS",
    "moassAbi": "MOASS",
    "sMoassAbi": "StakedMOASS",
    "stakingAbi": "Staking",
    "treasuryAbi": "Treasury",
    "bondDepositoryAbi": "BondDepository",
    "oracleAbi": "PairOracle",
    "gmeDeskAbi": "GmeDesk",
    "inverseBondAbi": "InverseBond",
    "genesisBondAbi": "GenesisBond",
    "pairAbi": "MockPair",
}

SIG = re.compile(r"'function\s+(\w+)\s*\(([^)]*)\)([^']*)'")


def split_types(chunk):
    """'address owner, uint256 value' -> ['address', 'uint256']"""
    out = []
    for part in chunk.split(","):
        part = part.strip()
        if not part:
            continue
        # Drop the argument name and any location keyword.
        tokens = [t for t in part.split() if t not in ("calldata", "memory", "storage", "indexed")]
        out.append(tokens[0])
    return out


def parse_ts():
    src = open(ABIS_TS).read()
    blocks = {}
    for name in TARGETS:
        m = re.search(r"export const %s = parseAbi\(\[(.*?)\]\)" % name, src, re.S)
        if not m:
            continue
        entries = []
        for fn, args, tail in SIG.findall(m.group(1)):
            returns = []
            rm = re.search(r"returns\s*\(([^)]*)\)", tail)
            if rm:
                returns = split_types(rm.group(1))
            entries.append((fn, split_types(args), returns))
        blocks[name] = entries
    return blocks


def artifact_abi(contract):
    """Artifacts live at out/<file>.sol/<Contract>.json, and the file is not
    always named after the contract — the mocks share one."""
    direct = os.path.join(OUT, contract + ".sol", contract + ".json")
    if os.path.exists(direct):
        return json.load(open(direct))["abi"]
    for folder in os.listdir(OUT):
        candidate = os.path.join(OUT, folder, contract + ".json")
        if os.path.exists(candidate):
            return json.load(open(candidate))["abi"]
    return None


def canonical(entry):
    ins = [i["type"] for i in entry.get("inputs", [])]
    outs = [o["type"] for o in entry.get("outputs", [])]
    return ins, outs


def main():
    blocks = parse_ts()
    if not blocks:
        sys.exit("could not parse %s" % ABIS_TS)

    problems = []
    checked = 0

    for abi_name, entries in blocks.items():
        contract = TARGETS[abi_name]
        abi = artifact_abi(contract)
        if abi is None:
            problems.append("%s: no compiled artifact for %s (run forge build)" % (abi_name, contract))
            continue

        by_name = {}
        for e in abi:
            if e.get("type") == "function":
                by_name.setdefault(e["name"], []).append(canonical(e))

        for fn, ins, outs in entries:
            checked += 1
            if fn not in by_name:
                problems.append("%s.%s: not on %s" % (abi_name, fn, contract))
                continue
            overloads = by_name[fn]
            if not any(real_ins == ins for real_ins, _ in overloads):
                problems.append(
                    "%s.%s: inputs %s do not match %s%s"
                    % (abi_name, fn, ins, contract, [o[0] for o in overloads])
                )
                continue
            # Outputs only need to match when the front end declares them.
            if outs:
                match = [o for i, o in overloads if i == ins]
                if match and match[0] != outs:
                    problems.append(
                        "%s.%s: returns %s but %s returns %s"
                        % (abi_name, fn, outs, contract, match[0])
                    )

    print("checked %d signatures across %d ABIs" % (checked, len(blocks)))
    if problems:
        print("\nMISMATCHES:")
        for p in problems:
            print("  " + p)
        sys.exit(1)
    print("every front-end ABI signature matches the compiled contracts")


if __name__ == "__main__":
    main()
