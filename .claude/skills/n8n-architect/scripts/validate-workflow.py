#!/usr/bin/env python3
"""Valida JSON de workflow n8n antes de importar/criar via MCP.

Uso: python validate-workflow.py <arquivo.json>
"""
import json
import re
import sys
from pathlib import Path

DEPRECATED_TYPES = {
    "n8n-nodes-base.function": "use 'Code' (n8n-nodes-base.code)",
    "n8n-nodes-base.functionItem": "use 'Code' com Run Once For Each Item",
}


def check(workflow):
    errors, warnings, infos = [], [], []
    nodes = workflow.get("nodes", [])
    connections = workflow.get("connections", {})
    name = workflow.get("name", "<sem nome>")

    # 1. Nome com [claudio-vN]
    if not re.search(r"\[claudio-v\d+\]", name):
        errors.append(f"Nome sem sufixo [claudio-vN]: '{name}'")

    # 2. Active deve ser false
    if workflow.get("active") is True:
        errors.append("Workflow está com active=true. Ao criar deve ser false.")

    # 3. Tem nós
    if not nodes:
        errors.append("Workflow sem nós.")
        return errors, warnings, infos

    # 4. Sticky note de header
    has_header_sticky = any(
        n.get("type") == "n8n-nodes-base.stickyNote"
        and "Objetivo" in (n.get("parameters", {}).get("content", ""))
        for n in nodes
    )
    if not has_header_sticky:
        warnings.append("Sem sticky note de header (Objetivo / Gatilho / Autor).")

    # 5. Tags
    tag_names = [t.get("name") for t in workflow.get("tags", []) if isinstance(t, dict)]
    if "claudio" not in tag_names:
        warnings.append("Tag 'claudio' ausente.")

    node_names = {n.get("name"): n for n in nodes}

    for n in nodes:
        nname = n.get("name", "<sem nome>")
        ntype = n.get("type", "")

        # 6. Nós deprecados
        if ntype in DEPRECATED_TYPES:
            errors.append(f"Nó '{nname}' usa tipo deprecado {ntype}. {DEPRECATED_TYPES[ntype]}")

        # 7. Webhooks sem responseMode
        if ntype == "n8n-nodes-base.webhook":
            params = n.get("parameters", {})
            if "responseMode" not in params:
                warnings.append(f"Webhook '{nname}' sem responseMode definido.")
            if not params.get("path"):
                errors.append(f"Webhook '{nname}' sem path.")

        # 8. HTTP Request sem retry
        if ntype == "n8n-nodes-base.httpRequest":
            opts = n.get("parameters", {}).get("options", {}) or {}
            retry = opts.get("retry") or n.get("parameters", {}).get("retryOnFail")
            if not retry:
                infos.append(f"HTTP Request '{nname}' sem retry — considere ativar.")

        # 9. Code com lógica longa sem sticky next to it (heurística simples)
        if ntype == "n8n-nodes-base.code":
            code = n.get("parameters", {}).get("jsCode") or n.get("parameters", {}).get("pythonCode") or ""
            if code.count("\n") > 5:
                # checa se existe sticky proxima (mesma faixa Y)
                ny = (n.get("position") or [0, 0])[1]
                has_sticky_near = any(
                    s.get("type") == "n8n-nodes-base.stickyNote"
                    and abs((s.get("position") or [0, 0])[1] - ny) < 200
                    for s in nodes
                )
                if not has_sticky_near:
                    infos.append(f"Code '{nname}' com {code.count(chr(10))+1} linhas sem sticky note próximo.")

        # 10/11. Validar expressões dentro de strings que começam com "=" (n8n marker)
        def walk_strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for v in value.values():
                    yield from walk_strings(v)
            elif isinstance(value, list):
                for v in value:
                    yield from walk_strings(v)

        for s in walk_strings(n.get("parameters", {})):
            if not s.startswith("="):
                continue
            opens = s.count("{{")
            closes = s.count("}}")
            if opens != closes:
                errors.append(f"Nó '{nname}' tem expressão com {{}} desbalanceadas ({opens}/{closes}): {s[:80]}")
            for ref in re.findall(r'\$node\["([^"]+)"\]', s):
                if ref not in node_names:
                    errors.append(f"Nó '{nname}' referencia $node[\"{ref}\"] que não existe no workflow.")
        # Code nodes: validar JS/Python
        if ntype == "n8n-nodes-base.code":
            code = n.get("parameters", {}).get("jsCode", "") or n.get("parameters", {}).get("pythonCode", "")
            for ref in re.findall(r'\$node\["([^"]+)"\]', code):
                if ref not in node_names:
                    errors.append(f"Nó '{nname}' (Code) referencia $node[\"{ref}\"] inexistente.")

    # 12. Conexões consistentes (todo source/target existe)
    referenced = set()
    for src, branches in connections.items():
        if src not in node_names:
            errors.append(f"Conexão a partir de nó inexistente: '{src}'.")
        referenced.add(src)
        for branch in branches.get("main", []) or []:
            for conn in branch or []:
                tgt = conn.get("node")
                referenced.add(tgt)
                if tgt not in node_names:
                    errors.append(f"Conexão para nó inexistente: '{tgt}'.")

    # 13. Nós órfãos (sem entrada nem saída, exceto triggers e stickies)
    trigger_types = {
        "n8n-nodes-base.webhook",
        "n8n-nodes-base.scheduleTrigger",
        "n8n-nodes-base.manualTrigger",
        "n8n-nodes-base.errorTrigger",
        "n8n-nodes-base.workflowTrigger",
        "n8n-nodes-base.stickyNote",
    }
    for n in nodes:
        if n.get("type") in trigger_types:
            continue
        nname = n.get("name")
        if nname not in referenced and not connections.get(nname):
            warnings.append(f"Nó '{nname}' parece órfão (sem conexão de entrada nem saída).")

    # 14. Error Workflow configurado
    settings = workflow.get("settings", {}) or {}
    if not settings.get("errorWorkflow"):
        infos.append("Sem Error Workflow configurado em settings.errorWorkflow.")

    # 15. Pinned data (não deve haver em workflow pronto pra criar)
    if workflow.get("pinData"):
        warnings.append("Workflow contém pinData — limpar antes de criar em produção.")

    return errors, warnings, infos


def main():
    if len(sys.argv) != 2:
        print("Uso: validate-workflow.py <arquivo.json>")
        sys.exit(2)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"[ERRO] Arquivo não encontrado: {path}")
        sys.exit(2)

    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[ERRO] JSON inválido: {e}")
        sys.exit(1)

    errors, warnings, infos = check(workflow)

    print(f"=== Validação: {workflow.get('name', path.name)} ===")
    print(f"Nós: {len(workflow.get('nodes', []))}")
    print()

    for e in errors:
        print(f"[ERRO]  {e}")
    for w in warnings:
        print(f"[WARN]  {w}")
    for i in infos:
        print(f"[INFO]  {i}")

    if not (errors or warnings or infos):
        print("[OK] Nenhum problema detectado.")

    print()
    print(f"Resumo: {len(errors)} erro(s), {len(warnings)} aviso(s), {len(infos)} info(s).")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
