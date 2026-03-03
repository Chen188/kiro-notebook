#!/usr/bin/env python3
"""ACP Demo 5: Permission handling — observe and respond to session/request_permission."""

import json
import os
import shutil
import subprocess
import sys

KIRO = shutil.which("kiro-cli") or "kiro-cli"
CWD = os.getcwd()

def jsonrpc(id, method, params):
    return json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params})

proc = subprocess.Popen(
    [KIRO, "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1
)

def send(id, method, params):
    msg = jsonrpc(id, method, params)
    print(f"\n>>> {method} (id={id})")
    proc.stdin.write(msg + "\n")
    proc.stdin.flush()

def respond(id, result):
    """Send a JSON-RPC response (for requests FROM the agent)."""
    msg = json.dumps({"jsonrpc": "2.0", "id": id, "result": result})
    print(f"\n>>> respond (id={id}): {json.dumps(result)}")
    proc.stdin.write(msg + "\n")
    proc.stdin.flush()

AUTO_ALLOW = "--auto-allow" in sys.argv

def prompt_user_permission(request_msg):
    """Show permission request and ask user to allow/reject."""
    params = request_msg.get("params", {})
    tool_call = params.get("toolCall", {})
    options = params.get("options", [])

    print(f"\n{'='*60}")
    print(f"🔐 PERMISSION REQUEST")
    print(f"   Tool: {tool_call.get('title', 'unknown')}")
    print(f"   Kind: {tool_call.get('kind', 'unknown')}")
    print(f"   Status: {tool_call.get('status', 'unknown')}")
    if tool_call.get("content"):
        for c in tool_call["content"]:
            if c.get("type") == "diff":
                print(f"   File: {c.get('path', '')}")
            elif c.get("type") == "content":
                inner = c.get("content", {})
                print(f"   Detail: {inner.get('text', '')[:200]}")
    if tool_call.get("rawInput"):
        raw = json.dumps(tool_call["rawInput"], ensure_ascii=False)
        print(f"   Input: {raw[:300]}")

    print(f"\n   Options:")
    for i, opt in enumerate(options):
        print(f"     [{i}] {opt['name']} ({opt['kind']})")

    if AUTO_ALLOW:
        idx = 0
        print(f"\n   [auto-allow] → {options[0]['name']}")
    else:
        choice = input(f"\n   Choose [0-{len(options)-1}] (default 0): ").strip()
        idx = int(choice) if choice.isdigit() and int(choice) < len(options) else 0

    selected = options[idx]
    print(f"   → Selected: {selected['name']}")
    print(f"{'='*60}")

    return {"outcome": {"outcome": "selected", "optionId": selected["optionId"]}}

def read_loop(expected_id):
    """Read messages, handle permission requests, until we get the final response."""
    while True:
        line = proc.stdout.readline().strip()
        if not line:
            continue
        msg = json.loads(line)

        # Agent-initiated REQUEST (has "id" + "method") — e.g. session/request_permission
        if "id" in msg and "method" in msg:
            method = msg["method"]
            req_id = msg["id"]
            print(f"\n<<< Agent request: {method} (id={req_id})")

            if method == "session/request_permission":
                result = prompt_user_permission(msg)
                respond(req_id, result)
            else:
                print(f"    (unknown agent request, raw: {json.dumps(msg, ensure_ascii=False)[:500]})")
                respond(req_id, {})
            continue

        # Notification (no "id") — session/update etc.
        if "id" not in msg:
            method = msg.get("method", "")
            if method == "session/update":
                u = msg["params"]["update"]
                ut = u.get("sessionUpdate", "")
                if ut == "agent_message_chunk":
                    print(u.get("content", {}).get("text", ""), end="")
                elif ut == "turn_end":
                    print("\n[turn_end]")
                elif ut == "tool_call":
                    print(f"\n[tool_call] {u.get('title', '')} ({u.get('kind', '')}) - {u.get('status', '')}")
                elif ut == "tool_call_update":
                    status = u.get("status", "")
                    print(f"[tool_update] {status}")
                else:
                    print(f"[{ut}] {json.dumps(u, ensure_ascii=False)[:200]}")
            else:
                print(f"[notification] {method}: {json.dumps(msg, ensure_ascii=False)[:200]}")
            continue

        # Response to OUR request
        if msg.get("id") == expected_id:
            if "error" in msg:
                print(f"\n<<< ERROR: {msg['error']}")
            else:
                print(f"\n<<< OK (id={expected_id})")
            return msg

# --- Main flow ---

# 1. Initialize
send(0, "initialize", {
    "protocolVersion": 1,
    "clientCapabilities": {},
    "clientInfo": {"name": "acp-permission-demo", "version": "0.1.0"},
})
resp = read_loop(0)
caps = resp.get("result", {})
print(f"Agent: {caps.get('agentInfo', {})}")
print(f"Capabilities: {json.dumps(caps.get('agentCapabilities', {}))}")

# 2. New session
send(1, "session/new", {"cwd": CWD, "mcpServers": []})
resp = read_loop(1)
session_id = resp.get("result", {}).get("sessionId", "")
print(f"Session: {session_id}")

# 3. Send a prompt that triggers tool use (file write should need permission)
prompt_text = "Create a file called /tmp/acp_permission_test.txt with the content 'hello from ACP permission test'. Use the file write tool."
print(f"\nPrompt: {prompt_text}")
send(2, "session/prompt", {
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": prompt_text}],
})
resp = read_loop(2)
print(f"\nStop reason: {resp.get('result', {}).get('stopReason', '')}")

proc.terminate()
