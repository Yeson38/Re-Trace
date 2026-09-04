import json
def show(name, want_last, want_max_depth, must_have_loops=None, must_have_vars=None):
    f=json.load(open(f'samples/{name}.trace.json'))
    s=f['steps']
    depths=[x['depth'] for x in s]
    loops=sorted({l['id'] for x in s for l in x['loops']})
    allvars=sorted({v['name'] for x in s for v in x['vars']})
    outs=''.join(x['output'] for x in s).strip()
    ok=True
    if outs != want_last:
        print('FAIL',name,'output',repr(outs),'!=',repr(want_last))
        ok=False
    if max(depths) != want_max_depth:
        print('FAIL',name,'max depth',max(depths),'!=',want_max_depth)
        ok=False
    if must_have_loops and any(l not in loops for l in must_have_loops):
        print('FAIL',name,'loops',loops,'missing',must_have_loops)
        ok=False
    if must_have_vars and any(v not in allvars for v in must_have_vars):
        print('FAIL',name,'vars',allvars,'missing',must_have_vars)
        ok=False
    if not all(set(x)>={'line','depth','vars','loops','output','globalStep'}
               and isinstance(x['vars'],list) and isinstance(x['loops'],list)
               for x in s):
        print('FAIL',name,'bad shape')
        ok=False
    uniq=[]; prev=-1
    for x in s:
        if x['depth']!=prev:
            uniq.append(f"L{x['line']}:d{x['depth']}")
            prev=x['depth']
    print(f"{name:12} ok={ok} steps={len(s):3} max_depth={max(depths)} loops={loops} vars={allvars} Σout={outs!r}")
    print(f"             depth transitions: {' -> '.join(uniq[:14])}{' …' if len(uniq)>14 else ''}")
    return ok
ok = show('bubble_sort', '1 2 4 5 8', 2,
          must_have_loops=['L9','L10','L24'],
          must_have_vars=['data','arr','n','i','j','tmp'])
ok = show('factorial', '24', 5, must_have_vars=['n']) and ok
ok = show('gcd_while', '6', 2, must_have_loops=['L8'], must_have_vars=['a','b','t']) and ok
print('ALL:', 'OK' if ok else 'FAIL')
