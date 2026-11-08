"""Batch selection shares the same runner, snapshot and event protocol.

No directory-wide replay of arbitrary JSON files: only selected play assets are
compiled, with their separate scenarios, and each play cleans up before the next.
"""
from common import compile_request
from player import run


def run_suite(command, output=None):
    inspected = compile_request(command)
    if not inspected["ok"]:
        return inspected
    return run(inspected, command, output)
