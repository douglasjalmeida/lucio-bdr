#!/usr/bin/env python3
"""Compara dois workflows n8n e produz diff legível.

Uso: python n8n-diff.py <antes.json> <depois.json>
"""
import json
import sys
from pathlib import Path


def index_nodes(workflow):
    return {n["name"]: n for n in workflow.get("nodes", []) if n.get("type") != "n8n-nodes-base.stickyNote"}


def node_signature(node):
    """Hash semântico ignorando posição visual e ID."""
    return {
        "type": node.get("type"),
        "typeVersion": node.get("typeVersion"),
        "parameters": node.get("parameters"),
        "credentials": node.get("credentials"),
    }


def diff_connections(a, b):
    a_conn = a.get("connections", {})
    b_conn = b.get("connections", {})
    added, removed = [], []
    all_keys = set(a_conn) | set(b_conn)
    for k in all_keys:
        a_targets = _flatten(a_conn.get(k, {}))
        b_targets = _flatten(b_conn.get(k, {}))
        for t in b_targets - a_targets:
            added.append(f"{k} → {t}")
        for t in a_targets - b_targets:
            removed.append(f"{k} → {t}")
    return added, removed


def _flatten(branches):
    result = set()
    for branch in branches.get("main", []) or []:
        for conn in branch or []:
            result.add(conn.get("node"))
    return result


def main():
    if len(sys.argv) != 3:
        print("Uso: n8n-diff.py <antes.json> <depois.json>")
        sys.exit(2)

    a = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    b = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))

    a_nodes = index_nodes(a)
    b_nodes = index_nodes(b)

    print(f"=== Diff: '{a.get('name')}' → '{b.get('name')}' ===\n")

    added = sorted(set(b_nodes) - set(a_nodes))
    removed = sorted(set(a_nodes) - set(b_nodes))
    common = sorted(set(a_nodes) & set(b_nodes))

    if added:
        print("+ Nós adicionados:")
        for n in added:
            print(f"  + {n} ({b_nodes[n].get('type')})")
        print()

    if removed:
        print("- Nós removidos:")
        for n in removed:
            print(f"  - {n} ({a_nodes[n].get('type')})")
        print()

    modified = []
    for n in common:
        if node_signature(a_nodes[n]) != node_signature(b_nodes[n]):
            modified.append(n)

    if modified:
        print("~ Nós modificados:")
        for n in modified:
            print(f"  ~ {n}")
            sa = node_signature(a_nodes[n])
            sb = node_signature(b_nodes[n])
            for k in ("type", "typeVersion", "parameters", "credentials"):
                if sa.get(k) != sb.get(k):
                    print(f"      • {k} mudou")
        print()

    conn_added, conn_removed = diff_connections(a, b)
    if conn_added:
        print("+ Conexões adicionadas:")
        for c in conn_added:
            print(f"  + {c}")
        print()
    if conn_removed:
        print("- Conexões removidas:")
        for c in conn_removed:
            print(f"  - {c}")
        print()

    # Settings
    if a.get("settings") != b.get("settings"):
        print("~ settings alterado")
    if a.get("active") != b.get("active"):
        print(f"~ active: {a.get('active')} → {b.get('active')}")

    if not (added or removed or modified or conn_added or conn_removed):
        print("Nenhuma diferença semântica detectada.")


if __name__ == "__main__":
    main()
