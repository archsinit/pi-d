"""Offline PTY check of the explicit experiment helper; never uses normal config/auth/sessions."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

root = Path(__file__).resolve().parents[1]
helper = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(root / "bin/pi-d-subagents.mjs")
node = sys.argv[2] if len(sys.argv) > 2 else "node"


def deadline(_signal, _frame):
    raise TimeoutError("Isolated subagent PTY did not shut down promptly")


signal.signal(signal.SIGALRM, deadline)
signal.alarm(25)
with tempfile.TemporaryDirectory(prefix="pi-d-subagent-pty-") as directory:
    base = Path(directory).resolve()
    # Even the helper's parent has a fake HOME and no inherited credentials/preloads.
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(base), "TMPDIR": str(base),
                   "XDG_CONFIG_HOME": str(base / "normal-config"), "XDG_DATA_HOME": str(base / "normal-data"),
                   "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8",
                   "ANTHROPIC_API_KEY": "unused-test-sentinel"}
    plan = json.loads(subprocess.check_output([node, helper, "--check"], cwd=directory, env=environment))
    experiment = Path(plan["experiment"])
    assert str(experiment).startswith(str(base) + "/")
    assert "ANTHROPIC_API_KEY" not in plan["environment"]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([node, helper, "--experiment", str(experiment)], cwd=directory,
                               env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    captured = bytearray()

    def wait_for(token, start=0):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if token in captured[start:]:
                return
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        raise AssertionError(f"Missing {token!r}; terminal tail: {bytes(captured[-1800:])!r}")

    try:
        wait_for(b"ChatGPT is not connected")
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        start = len(captured)
        os.write(master, b"/agents\r")
        wait_for(b"No subagent jobs yet", start)
        os.write(master, b"\x03")
        until = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < until:
            if select.select([master], [], [], 0.05)[0]:
                captured.extend(os.read(master, 65536))
        assert process.poll() == 0, bytes(captured[-1800:])
        restored = termios.tcgetattr(slave)
        assert restored[3] & termios.ICANON == original[3] & termios.ICANON
        assert restored[3] & termios.ECHO == original[3] & termios.ECHO
        assert Path(plan["session"]).is_file()
        assert not Path(plan["session"] + ".lock").exists()
        assert not (base / "normal-config").exists() and not (base / "normal-data").exists()
        assert not (experiment / "config/pi-d/auth.json").exists()
        assert b"Unhandled" not in captured and b"TypeError" not in captured
        print("PTY passed: isolated subagent helper, separate HOME/XDG/session/workspace, auth gate, /agents, exit and terminal restoration.")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        os.close(slave)
signal.alarm(0)
