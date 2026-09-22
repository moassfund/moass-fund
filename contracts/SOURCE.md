# Upstream source provenance

`reference/` holds the **unmodified** NetNet Capital contracts, fetched from Sourcify and verified
byte-for-byte against the code deployed on Robinhood Chain (chain id 4663). Nothing in `reference/`
is ever edited. Our fork lives in `src/`, and `diff -r reference/src src` is the complete,
reviewable statement of everything Moass Fund changes.

## Licence

All 32 files are **AGPL-3.0-only**. Our fork inherits that licence: the Moass Fund contracts must be
published in source form. This is not optional and is not negotiable by us.

## What was fetched

Source: `https://sourcify.dev/server/v2/contract/4663/<address>`
Fetched: 2026-09-21 · 13 contracts · 32 unique source files · 2,898 lines
Compiler: `0.8.30+commit.73712a01`, optimizer on / 800 runs, `evmVersion = osaka`, `viaIR = false`,
`bytecodeHash = ipfs`, remapping `forge-std/=lib/forge-std/src/`.

Those settings are reproduced exactly in `reference/foundry.toml`. They matter: the remapping string
is hashed into each contract's metadata, so changing it alone breaks bytecode equivalence.

| Contract | Address | Sourcify | Verified |
|---|---|---|---|
| `NET` | `0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf` | exact match | 2026-07-16 |
| `StakedNET` | `0xb773ec2C326B7f98a5a83fc098825492F020a4c7` | exact match | 2026-07-16 |
| `Staking` | `0xB078cc304A0B264C5F3680DC0488954ACcd02E87` | exact match | 2026-07-16 |
| `Distributor` | `0x79e71F8a8a2912E40687a8820b2dC0fdd2f686b3` | exact match | 2026-07-16 |
| `Treasury` | `0x04822Ea321A0DEE6F40656172F29312104855d66` | exact match | 2026-07-16 |
| `BondDepository` | `0xff32a969A0c567129eECD926D04657728E1980C1` | exact match | 2026-07-16 |
| `PairOracle` | `0x929631b33F4070D6f54477fba3FD27566567dAca` | exact match | 2026-07-16 |
| `TaxCollector` | `0x086C58400b8708Ef993f256E12e752dcF0AC918e` | exact match | 2026-07-16 |
| `GenesisBond` | `0x575b7B7c97Ef3E21C82DAeB427899d583e1E913f` | exact match | 2026-07-16 |
| `InverseBond` | `0x92166e94Eea5B7799b761653881692f881dFC4C9` | exact match | 2026-07-16 |
| `PremiumSeller` | `0x346e1a31171A0f7aC73909010b5435768d3B5462` | exact match | 2026-07-16 |
| `PTeam` | `0x650F58079dAa17ee28928c2F92d22291d038B2B0` | exact match | 2026-07-16 |
| `ShareCertificate` | `0xfB8058769063519f26FB114631919c0E5254068e` | exact match | 2026-07-16 |

## Verification

```
python3 tools/fetch_upstream.py     # re-download into reference/ (idempotent)
cd reference && forge build
python3 ../tools/verify_upstream.py # compile output vs deployed bytecode
```

`verify_upstream.py` compares our compiled runtime bytecode against `eth_getCode` for each address
and asserts that **every differing byte falls inside a constructor-immutable slot** (read from the
artifact's `immutableReferences`). Immutables are baked into runtime code at deploy time and are
expected to differ; anything outside them would mean the source is not what is deployed.

Result as of 2026-09-21: all 13 contracts identical in length, all 13 metadata hashes match, and
every byte difference is accounted for by an immutable. Re-run this after any upstream re-fetch.
