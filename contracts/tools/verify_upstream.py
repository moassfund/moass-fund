import json, subprocess, os
R="https://robinhood-rpc.publicnode.com"
PAIRS=[("NET","0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf"),("StakedNET","0xb773ec2C326B7f98a5a83fc098825492F020a4c7"),
("Staking","0xB078cc304A0B264C5F3680DC0488954ACcd02E87"),("Distributor","0x79e71F8a8a2912E40687a8820b2dC0fdd2f686b3"),
("Treasury","0x04822Ea321A0DEE6F40656172F29312104855d66"),("BondDepository","0xff32a969A0c567129eECD926D04657728E1980C1"),
("PairOracle","0x929631b33F4070D6f54477fba3FD27566567dAca"),("TaxCollector","0x086C58400b8708Ef993f256E12e752dcF0AC918e"),
("GenesisBond","0x575b7B7c97Ef3E21C82DAeB427899d583e1E913f"),("InverseBond","0x92166e94Eea5B7799b761653881692f881dFC4C9"),
("PremiumSeller","0x346e1a31171A0f7aC73909010b5435768d3B5462"),("PTeam","0x650F58079dAa17ee28928c2F92d22291d038B2B0"),
("ShareCertificate","0xfB8058769063519f26FB114631919c0E5254068e")]

def onchain(a):
    o=subprocess.run(["cast","code",a,"-r",R],capture_output=True,text=True).stdout.strip()
    return bytes.fromhex(o[2:] if o.startswith("0x") else o)

ok=True
print("%-18s %-10s %-24s %s" % ("CONTRACT","IMMUTABLES","BYTES DIFF / IN IMM SLOTS","VERDICT"))
for name,addr in PAIRS:
    art=json.load(open(os.path.join("out",name+".sol",name+".json")))
    loc=bytes.fromhex(art["deployedBytecode"]["object"][2:])
    ch=onchain(addr)
    imm=art["deployedBytecode"].get("immutableReferences") or {}
    covered=set()
    for refs in imm.values():
        for r in refs:
            covered.update(range(r["start"], r["start"]+r["length"]))
    diff={i for i,(x,y) in enumerate(zip(ch,loc)) if x!=y}
    outside=diff-covered
    verdict="clean" if not outside else "!! %d BYTES OUTSIDE IMMUTABLES" % len(outside)
    if outside: ok=False
    print("%-18s %-10d %-24s %s" % (name, len(imm), "%d diff / %d immutable bytes"%(len(diff),len(covered)), verdict))
print()
print("VERIFIED: local build == deployed bytecode, modulo constructor immutables" if ok
      else "UNEXPLAINED DIFFERENCES - investigate")
