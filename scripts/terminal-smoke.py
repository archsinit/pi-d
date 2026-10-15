"""Credential-free smoke test of the real ProcessTerminal in a POSIX PTY."""
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
launcher = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(root / "bin/pi-d.mjs")
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
original = termios.tcgetattr(slave)
process = subprocess.Popen(
    [launcher, "--demo", "--no-animation"],
    cwd=tempfile.gettempdir(), stdin=slave, stdout=slave, stderr=slave,
    env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
)
captured = bytearray()


def wait_for(token, start=0, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if token in captured[start:]:
            return
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            captured.extend(os.read(master, 65536))
    raise AssertionError(f"Missing {token!r}; terminal tail: {bytes(captured[-2000:])!r}")


try:
    wait_for(b"pi-d")
    wait_for(b"ready")
    assert not termios.tcgetattr(slave)[3] & termios.ICANON
    os.write(master, "\x1b[200~Hello 你好 👩🏽‍💻\nsecond line\x1b[201~".encode())
    wait_for(b"second line")
    start = len(captured)
    os.write(master, b"\r")
    wait_for(b"responding", start)
    os.write(master, b"\x1b")
    wait_for(b"ready", start)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 52, 0, 0))
    process.send_signal(signal.SIGWINCH)
    time.sleep(0.1)
    os.write(master, b"/new\r")
    wait_for(b"ready", start=len(captured))
    os.write(master, b"/clear\r")
    wait_for(b"ready", start=len(captured))
    os.write(master, b"\x03")  # Ctrl+C is raw input, not SIGINT.
    deadline = time.monotonic() + 5
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            captured.extend(os.read(master, 65536))
    assert process.poll() == 0, f"Exit failed; terminal tail: {bytes(captured[-2000:])!r}"
    # ProcessTerminal restores canonical input and echo before handing the shell back.
    restored = termios.tcgetattr(slave)
    assert restored[3] & termios.ICANON == original[3] & termios.ICANON
    assert restored[3] & termios.ECHO == original[3] & termios.ECHO
    while select.select([master], [], [], 0)[0]:
        captured.extend(os.read(master, 65536))
    assert b"\x1b[?1049h" in captured and b"\x1b[?1049l" in captured
    assert b"\x1b[?25h" in captured
    assert b"Unhandled" not in captured and b"TypeError" not in captured
    print("PTY passed: startup, paste, streaming, Escape, resize, /new, /clear, exit, terminal restoration.")
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)

# Without login, local commands stay usable but OpenAI admission/recovery stay paused.
# Use separate homes; never inspect or modify the user's credentials/session.
with tempfile.TemporaryDirectory(prefix="pi-d-startup-") as directory:
    environment = {**os.environ, "HOME": directory, "TERM": "xterm-256color", "COLORTERM": "truecolor",
                   "XDG_DATA_HOME": directory + "/data", "XDG_CONFIG_HOME": directory + "/config",
                   "OPENAI_API_KEY": "sk-test-key-that-must-not-be-used"}
    for attempt in range(2):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        original = termios.tcgetattr(slave)
        captured = bytearray()
        process = subprocess.Popen(
            [launcher, "--session", "./notes.sqlite"],
            cwd=directory, stdin=slave, stdout=slave, stderr=slave, env=environment,
        )
        try:
            wait_for(b"ChatGPT is not connected")
            assert process.poll() is None
            assert not termios.tcgetattr(slave)[3] & termios.ICANON
            os.write(master, b"/reasoning max\r")
            wait_for(b"Reasoning: max.")
            os.write(master, b"/help\r")
            wait_for(b"Workspace:")
            start = len(captured)
            os.write(master, b"\x1b")  # Cancel the overlay; the slash command is restored.
            wait_for(b"Cancelled", start)
            os.write(master, b"\x03")  # Close after the command is settled.
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    captured.extend(os.read(master, 65536))
            assert process.poll() == 0, bytes(captured[-2000:])
            restored = termios.tcgetattr(slave)
            assert restored[3] & termios.ICANON == original[3] & termios.ICANON
            assert restored[3] & termios.ECHO == original[3] & termios.ECHO
            assert b"\x1b[?1049h" in captured and b"\x1b[?1049l" in captured
            assert Path(directory + "/notes.sqlite").is_file()
            assert not Path(directory + "/notes.sqlite.lock").exists()
            assert not Path(directory + "/data").exists()
            assert not Path(directory + "/config/pi-d/auth.json").exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)
    print("PTY passed: saved workspace/relative session, local commands without login, auth gate, dialog cancellation, cleanup and retry.")

# Managed creation and startup resume, using only local commands and missing-login auth gates.
with tempfile.TemporaryDirectory(prefix="pi-d-managed-") as directory:
    directory = str(Path(directory).resolve())
    environment = {**os.environ, "HOME": directory, "TERM": "xterm-256color", "COLORTERM": "truecolor",
                   "XDG_DATA_HOME": directory + "/data", "XDG_CONFIG_HOME": directory + "/config"}
    for mode in ["--new-session", "--resume"]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
        original = termios.tcgetattr(slave)
        captured = bytearray()
        process = subprocess.Popen([launcher, mode, "--no-animation"], cwd=directory,
                                   stdin=slave, stdout=slave, stderr=slave, env=environment)
        try:
            if mode == "--resume":
                wait_for(b"Resume a session")
                os.write(master, b"\r")
            wait_for(b"ChatGPT is not connected")
            wait_for(b"ctx ~")
            os.write(master, b"/sta")
            wait_for(b"Session, workspace")
            os.write(master, b"\t\r")
            wait_for(b"Session:")
            os.write(master, b"\r")
            wait_for(b"ready", start=len(captured))
            if mode == "--new-session":
                start = len(captured)
                os.write(master, b"/session-new second\r")
                wait_for(b"ChatGPT is not connected", start)
            os.write(master, b"\x03")
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    captured.extend(os.read(master, 65536))
            assert process.poll() == 0, bytes(captured[-2000:])
            restored = termios.tcgetattr(slave)
            assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
            assert b"\x1b[?1049l" in captured and b"\x1b[?25h" in captured
            stores = list(Path(directory + "/data/pi-d/sessions").rglob("*.sqlite"))
            assert len(stores) == 2
            assert all(not Path(str(file) + ".lock").exists() for file in stores)
            assert not Path(directory + "/data/pi-d/default.sqlite").exists()
            assert not Path(directory + "/config/pi-d/auth.json").exists()
            assert b"Unhandled" not in captured and b"TypeError" not in captured
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)
    print("PTY passed: command completion, context meter, /status, managed creation/handoff, workspace resume and private lock-free shutdown.")

# Global code is trusted only in the user's config directory. Verify actual CLI
# wiring, opt-out, canonical-path deduplication and project isolation in a PTY.
with tempfile.TemporaryDirectory(prefix="pi-d-extension-startup-") as directory:
    base = Path(directory).resolve()
    workspace = base / "workspace"
    workspace.mkdir()
    extensions = base / "config/pi-d/extensions"
    extensions.mkdir(parents=True)
    extensions.parent.chmod(0o700)  # The credential-store parent must remain private.
    automatic_marker, explicit_marker = base / "automatic.loaded", base / "explicit.loaded"

    def fixture(name, marker):
        return (f'import {{ appendFileSync }} from "node:fs"; '
                f'appendFileSync({json.dumps(str(marker))}, "loaded"); '
                f'export default {{ name: {json.dumps(name)}, piD: {{ commands: [{{ '
                'name: "present-local", description: "Offline UI presentation", execute(_args, api) { '
                'api.message("PTY-EXTENSION-MESSAGE"); '
                'api.toast("https://example.invalid/pty", { type: "success", timeoutMs: 0 }); '
                'api.notify("PTY-EXTENSION-NOTICE"); } }] } };')

    automatic = extensions / "automatic.mjs"
    automatic.write_text(fixture("automatic-probe", automatic_marker))
    alias = extensions / "alias.mjs"
    alias.symlink_to(automatic)
    explicit = base / "explicit.mjs"
    explicit.write_text(fixture("explicit-probe", explicit_marker))
    project = workspace / ".pi-d/extensions"
    project.mkdir(parents=True)
    (project / "must-not-load.mjs").write_text('throw new Error("PROJECT_EXTENSION_EXECUTED");')
    environment = {**os.environ, "HOME": str(base), "TERM": "xterm-256color", "COLORTERM": "truecolor",
                   "XDG_CONFIG_HOME": str(base / "config"), "XDG_DATA_HOME": str(base / "data")}
    for option in ["--help", "--list-models"]:
        result = subprocess.run([launcher, option], cwd=workspace, env=environment, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert not automatic_marker.exists()
    for mode, options, expected in [
        ("automatic", [], "automatic-probe"),
        ("deduplicated", ["--extension", str(automatic), "--extension", str(alias)], "automatic-probe"),
        ("disabled", ["--no-extensions"], None),
        ("explicit", ["--no-extensions", "--extension", str(explicit)], "explicit-probe"),
        ("demo", ["--demo"], None),
    ]:
        automatic_marker.unlink(missing_ok=True)
        explicit_marker.unlink(missing_ok=True)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
        original = termios.tcgetattr(slave)
        captured = bytearray()
        arguments = [launcher, *options, "--no-animation"]
        if mode != "demo":
            arguments.extend(["--session", f"./{mode}.sqlite"])
        process = subprocess.Popen(arguments, cwd=workspace, stdin=slave, stdout=slave, stderr=slave, env=environment)
        try:
            wait_for(b"ready" if mode == "demo" else b"ChatGPT is not connected")
            if expected:
                start = len(captured)
                os.write(master, b"/present-local\r")
                wait_for(b"PTY-EXTENSION-MESSAGE", start)
                wait_for(b"https://example.invalid/pty", start)
                wait_for(b"PTY-EXTENSION-NOTICE", start)
            os.write(master, b"/extensions\r")
            wait_for(b"Selected Durable extensions")
            if expected:
                wait_for(expected.encode())
            assert automatic_marker.exists() == (expected == "automatic-probe"), mode
            assert explicit_marker.exists() == (expected == "explicit-probe"), mode
            for marker in [automatic_marker, explicit_marker]:
                if marker.exists():
                    assert marker.read_text() == "loaded", "Extension executed more than once"
            start = len(captured)
            os.write(master, b"\x1b")
            wait_for(b"Cancelled", start)
            os.write(master, b"\x03")
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    captured.extend(os.read(master, 65536))
            assert process.poll() == 0, (mode, bytes(captured[-2000:]))
            restored = termios.tcgetattr(slave)
            assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
            assert b"PROJECT_EXTENSION_EXECUTED" not in captured
            assert not (base / "config/pi-d/auth.json").exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)
    print("PTY passed: global XDG extension discovery, UI-only extension messages/toasts/notices without login, explicit additions, symlink deduplication, --no-extensions, demo isolation and no project execution.")
