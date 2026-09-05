#!/usr/bin/env python3
import re, sys
from pathlib import Path

def check_error_discriminants():
    errors = []
    f = Path('contracts/registry/src/errors.rs')
    if not f.exists(): return [f'ERROR: {f} not found']
    text = f.read_text()
    m = re.search(r'pub enum Error \{([^}]+)\}', text, re.DOTALL)
    if not m: return ['ERROR: enum Error not found']
    d = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith('///'): continue
        match = re.match(r'(\w+)\s*=\s*(\d+)', line)
        if match:
            name, val = match.groups()
            if val in d:
                errors.append(f'ERROR: Duplicate discriminant {val}: {d[val]} and {name}')
            d[val] = name
    if not errors: print(f'OK: {len(d)} unique error discriminants')
    return errors

def check_migration_prefixes():
    errors = []
    d = Path('backend/src/db/migrations')
    if not d.exists(): return [f'ERROR: {d} not found']
    prefixes = {}
    for f in sorted(d.iterdir()):
        if f.suffix != '.sql': continue
        match = re.match(r'^(\d{3})_', f.name)
        if match:
            p = match.group(1)
            if p in prefixes:
                errors.append(f'ERROR: Duplicate migration prefix {p}: {prefixes[p]} and {f.name}')
            prefixes[p] = f.name
    if not errors: print(f'OK: {len(prefixes)} unique migration prefixes')
    return errors

errs = check_error_discriminants() + check_migration_prefixes()
if errs:
    print('
'.join(errs))
    sys.exit(1)
print('All ID uniqueness checks passed.')
