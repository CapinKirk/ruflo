#!/usr/bin/env python3
"""
n8n API deployment for the R360 Africa-triage feature.

Steps:
  1. Prep sub-r360-africa-triage workflow JSON (strip server fields, swap creds).
  2. POST to create new workflow in n8n; capture new ID.
  3. PATCH settings to bind error workflow + 24h timeout.
  4. Prep modified resolver JSON; substitute AFRICA_TRIAGE_PLACEHOLDER with new ID.
  5. PUT to update resolver workflow B5TE8DaCbbMqZatD.
  6. Activate the new triage workflow.
  7. Print verification summary.

Usage: python3 deliverables/r360-africa-triage/tests/deploy.py
Env required: N8N_API_KEY (loaded from .env.local)
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict

REPO = Path(__file__).resolve().parents[3]
TRIAGE_PATH = REPO / "deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json"
RESOLVER_PATH = REPO / "deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json"

API_BASE = "https://n8nweb.ec-ops.org/api/v1"
RESOLVER_ID = "B5TE8DaCbbMqZatD"
ERROR_WORKFLOW_ID = "K3pVAyECE0tCFQgw"  # R360 Sub: Error Handler

# Credential swaps (placeholder -> real)
CRED_SWAPS = {
    # The triage JSON ships with [RH] UAT as a placeholder for UAT-first deploys.
    # For prod go-live, swap to [SF Integration User] PROD.
    "JUyr1xCnPHSkU1tm": ("x11R2LzrMkyi8UnN", "[SF Integration User] PROD"),
    "SLACK_CREDENTIAL_PLACEHOLDER": ("skn3Ct9zjw3Vt3Pn", "RevTech Bot"),
}

# n8n public API only accepts these 5 fields on POST/PUT workflow.
# Anything else triggers "request/body must NOT have additional properties".
ALLOWED_FIELDS = {"name", "nodes", "connections", "settings", "staticData"}


def keep_only_allowed(workflow: Dict[str, Any]) -> Dict[str, Any]:
    payload = {k: v for k, v in workflow.items() if k in ALLOWED_FIELDS}
    # staticData must be present (can be null)
    if "staticData" not in payload:
        payload["staticData"] = None
    return payload

# Field-level swaps too: when n8n returns to the JSON it sometimes includes
# the credential by name only; we need to replace both id and name.
def swap_credentials_in_node(node: Dict[str, Any]) -> None:
    creds = node.get("credentials") or {}
    for cred_type, cred_ref in list(creds.items()):
        if not isinstance(cred_ref, dict):
            continue
        cred_id = cred_ref.get("id")
        if cred_id in CRED_SWAPS:
            new_id, new_name = CRED_SWAPS[cred_id]
            cred_ref["id"] = new_id
            cred_ref["name"] = new_name


def call_api(method: str, path: str, payload: Any = None, expect_json: bool = True) -> Any:
    api_key = os.environ.get("N8N_API_KEY")
    if not api_key:
        sys.exit("ERROR: N8N_API_KEY env var not set")
    url = f"{API_BASE}{path}"
    headers = {
        "X-N8N-API-KEY": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read().decode("utf-8", errors="replace")
            print(f"  {method} {path} -> HTTP {resp.status}")
            return json.loads(data) if expect_json and data else data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"  {method} {path} -> HTTP {e.code}")
        print(f"  body: {err_body[:600]}")
        raise


def main() -> int:
    print("=" * 70)
    print("R360 Africa Triage — n8n PROD deploy")
    print("=" * 70)

    # --- 1. Prep triage workflow payload ---
    print("\n[1] Loading and prepping triage workflow JSON...")
    triage = json.loads(TRIAGE_PATH.read_text())
    for node in triage.get("nodes", []):
        swap_credentials_in_node(node)
    triage["active"] = False  # set explicitly even though stripped (n8n decides on POST)
    triage_payload = keep_only_allowed(triage)
    # n8n create endpoint expects: name, nodes, connections, settings
    print(f"  Name: {triage_payload['name']}")
    print(f"  Nodes: {len(triage_payload['nodes'])}")
    print(f"  Credentials swapped: 2 SF + 4 Slack")

    # --- 2. POST to create ---
    print("\n[2] POST /workflows to create triage workflow...")
    created = call_api("POST", "/workflows", triage_payload)
    new_id = created.get("id")
    if not new_id:
        sys.exit(f"ERROR: no id in create response: {created}")
    print(f"  ✅ Created workflow id: {new_id}")

    # --- 3. Bind error workflow + timeout via PATCH ---
    # n8n public API doesn't have a generic PATCH for settings; we update via PUT
    # with the same payload + settings.errorWorkflow + settings.executionTimeout.
    print("\n[3] PUT /workflows/{id} to bind error workflow + 24h timeout...")
    triage_payload["settings"] = {
        **triage_payload.get("settings", {}),
        "errorWorkflow": ERROR_WORKFLOW_ID,
        "executionTimeout": 86400,  # 24 hours in seconds
        "saveExecutionProgress": True,
        "saveDataErrorExecution": "all",
        "saveDataSuccessExecution": "all",
    }
    call_api("PUT", f"/workflows/{new_id}", triage_payload)
    print(f"  ✅ errorWorkflow={ERROR_WORKFLOW_ID}, executionTimeout=86400s")

    # --- 4. Activate ---
    print("\n[4] POST /workflows/{id}/activate...")
    call_api("POST", f"/workflows/{new_id}/activate", {})
    print(f"  ✅ Triage workflow activated")

    # --- 5. Patch resolver workflow ---
    print("\n[5] Loading resolver, substituting placeholder...")
    resolver = json.loads(RESOLVER_PATH.read_text())
    resolver_node_count = len(resolver["nodes"])
    swapped = False
    for node in resolver["nodes"]:
        if node.get("name") == "Execute: sub-r360-africa-triage":
            if node["parameters"].get("workflowId") == "AFRICA_TRIAGE_PLACEHOLDER":
                node["parameters"]["workflowId"] = new_id
                swapped = True
                print(f"  ✅ Substituted AFRICA_TRIAGE_PLACEHOLDER -> {new_id}")
    if not swapped:
        sys.exit("ERROR: did not find AFRICA_TRIAGE_PLACEHOLDER in resolver. Aborting.")

    # n8n update of an existing workflow uses PUT /workflows/{id}
    resolver_payload = keep_only_allowed(resolver)
    # Preserve the existing settings; merge if needed
    print(f"  Resolver node count: {resolver_node_count}")

    print("\n[6] PUT /workflows/B5TE8DaCbbMqZatD to update resolver...")
    call_api("PUT", f"/workflows/{RESOLVER_ID}", resolver_payload)
    print(f"  ✅ Resolver updated with Africa fork wired in")

    # --- 7. Verification ---
    print("\n[7] Verifying live state...")
    triage_now = call_api("GET", f"/workflows/{new_id}")
    resolver_now = call_api("GET", f"/workflows/{RESOLVER_ID}")
    print(f"  Triage workflow:   active={triage_now.get('active')} nodes={len(triage_now.get('nodes', []))}")
    print(f"  Resolver workflow: active={resolver_now.get('active')} nodes={len(resolver_now.get('nodes', []))}")

    # Verify the resolver actually has the new Execute node pointing at the new ID
    exec_node = next(
        (n for n in resolver_now.get("nodes", []) if n.get("name") == "Execute: sub-r360-africa-triage"),
        None,
    )
    if exec_node:
        wired_id = exec_node["parameters"].get("workflowId")
        if wired_id == new_id:
            print(f"  ✅ Resolver's Execute node points at {wired_id}")
        else:
            print(f"  ❌ MISMATCH: resolver Execute node points at {wired_id}, expected {new_id}")
    else:
        print(f"  ❌ Resolver missing Execute: sub-r360-africa-triage node")

    print("\n" + "=" * 70)
    print(f"DEPLOY COMPLETE — triage workflow id: {new_id}")
    print("Next: manually fire a smoke payload through the resolver and watch for the Slack DM.")
    print("Rollback: deactivate workflow id above, or edit IF: Africa triage? condition.")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
