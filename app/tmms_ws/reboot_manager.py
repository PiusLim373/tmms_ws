#!/usr/bin/env python3
"""Host-side REST service for restarting parts of the TMMS stack from the dashboard.

Runs on the robot's host OS (NOT inside tmms_run) under supervisor as
[program:tmms_reboot_manager], because both things it does -- `docker exec` into the ROS
container and `supervisorctl` -- are host operations the containerised UI backend cannot
perform. It exposes two restart paths:

  rosbridge  Rosbridge occasionally stops feeding the dashboard while the rest of the stack
             is healthy. SIGINT the node inside tmms_run and let `ros2 launch` respawn it
             (operation.launch.py passes respawn:=true). Localization, the nav goal and
             every other node survive, which is the entire point of having this as a
             separate target from the container restart below.

  tmms_ws    `supervisorctl restart quadruped:tmms_ws` -- the full soft reboot, for when the
             ROS stack itself is wedged.

Binds loopback only. The UI reaches it through ui_backend.js, which proxies /api/system/*
here: the dashboard is served over https and a plain http call to this port would be blocked
as mixed content, and keeping the socket off the network means the sudo path below is not
remotely reachable.

Restarts take seconds (rosbridge) to a minute (container), so a POST does not block. It
starts a background worker and returns 202; the caller polls GET /status for the outcome.
Only one job runs at a time.
"""

import logging
import os
import socket
import subprocess
import threading
import time

from flask import Flask, jsonify

# Same env-var-with-default idiom as ui_backend.js, so the whole deployment is configured the
# same way even though the two services are in different languages.
PORT = int(os.environ.get('TMMS_REBOOT_PORT', '5055'))
CONTAINER = os.environ.get('TMMS_CONTAINER', 'tmms_run')
SUPERVISOR_PROGRAM = os.environ.get('TMMS_SUPERVISOR_PROGRAM', 'quadruped:tmms_ws')
ROSBRIDGE_PORT = int(os.environ.get('TMMS_ROSBRIDGE_PORT', '9090'))

# The stock Unitree secondary-development password. supervisorctl talks to a root-owned socket
# (chmod 0700) and this service runs as `unitree`, so `sudo -S` with the password on stdin is
# how it gets through. Overridable without editing this file if the robot's password changes.
SUDO_PASSWORD = os.environ.get('TMMS_SUDO_PASSWORD', 'Unitree0408')

# pkill -f patterns, anchored on the installed executable path rather than the bare node name.
#
# This is load-bearing, not tidiness. `-f rosbridge_websocket` is a substring match over whole
# command lines and also matches the parent `ros2 launch ... rosbridge_websocket_launch.xml`,
# so on a stack launched that way it SIGINTs the launch process itself and tears down
# everything instead of restarting one node. Verified: the loose pattern matched the launch
# parent and left the node alive; the anchored one matches only the node. operation.launch.py
# happens not to name rosbridge on its command line, so the loose form would work there today
# -- by luck, and only until someone launches rosbridge differently.
ROSBRIDGE_PATTERN = 'lib/rosbridge_server/rosbridge_websocket'
ROSAPI_PATTERN = 'lib/rosapi/rosapi_node'

# How long each target is given to come back before the job is marked failed.
ROSBRIDGE_TIMEOUT_S = 30.0
TMMS_WS_TIMEOUT_S = 120.0
POLL_INTERVAL_S = 1.0

# How long a /status environment probe is reused before being re-taken. See _probe().
PROBE_TTL_S = 2.0

log = logging.getLogger('reboot_manager')

app = Flask(__name__)

# Guards _job. Flask runs threaded, so two POSTs can land at once, and the worker thread
# writes _job while request threads read it.
_lock = threading.Lock()
_job = None

# (monotonic timestamp, snapshot) from the last /status probe. Racy by design: two concurrent
# requests may both probe and the later write wins, which costs one redundant probe and
# nothing else.
_probe_cache = None


# ---------------------------------------------------------------------------------------
# subprocess helpers
# ---------------------------------------------------------------------------------------

def _run(cmd, timeout=30.0, stdin=None):
    """Run an argv list and return (returncode, stdout+stderr).

    Always a list, never shell=True. Nothing from a request body ever reaches a command line
    -- the reboot targets are a fixed allowlist routed to separate handlers -- so there is no
    injection surface to defend, and this keeps it that way.
    """
    try:
        proc = subprocess.run(
            cmd,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, (proc.stdout or '').strip()
    except FileNotFoundError:
        return 127, f'{cmd[0]}: not found'
    except subprocess.TimeoutExpired:
        return 124, f'timed out after {timeout:g}s: {" ".join(cmd)}'


def _sudo(args, timeout=180.0):
    """supervisorctl et al via `sudo -S`, password on stdin.

    -k drops any cached sudo credential first, so this never silently depends on someone
    having run sudo in another session; the password on stdin is always what authenticates.
    """
    return _run(
        ['sudo', '-S', '-k', *args],
        timeout=timeout,
        stdin=SUDO_PASSWORD + '\n',
    )


def _container_running():
    rc, out = _run(
        ['docker', 'inspect', '-f', '{{.State.Running}}', CONTAINER], timeout=10.0)
    return rc == 0 and out.strip() == 'true'


def _port_listening(port, host='127.0.0.1', timeout=0.5):
    """TCP-connect check. Deliberately not a TLS handshake.

    rosbridge serves wss with a self-signed cert, so a real handshake would mean disabling
    verification to learn nothing extra: the socket accepting a connection already means the
    node re-bound the port, and the browser's own reconnect is the authoritative signal that
    it is serving again.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _wait_for(predicate, timeout_s):
    """Poll until predicate() is true. Returns True on success, False on timeout."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(POLL_INTERVAL_S)
    return predicate()


# ---------------------------------------------------------------------------------------
# reboot targets
# ---------------------------------------------------------------------------------------

def _reboot_rosbridge():
    """SIGINT rosbridge inside the container and wait for launch to respawn it.

    pkill runs inside tmms_run, which has its own PID namespace (the container is
    network_mode: host but not pid: host), so the pattern cannot match a host process.

    SIGINT goes to the node, not to the `ros2 launch` that is PID 1 -- launch only tears the
    stack down when it is signalled itself, so here it just observes a child exit and
    respawns it. Everything else in operation.launch.py keeps running.
    """
    if not _container_running():
        return False, f'{CONTAINER} is not running -- use the tmms_ws soft reboot instead.'

    rc, out = _run(
        ['docker', 'exec', CONTAINER, 'pkill', '-INT', '-f', ROSBRIDGE_PATTERN],
        timeout=15.0)
    if rc == 1:
        return False, f'no rosbridge_websocket process found in {CONTAINER}.'
    if rc != 0:
        return False, f'failed to signal rosbridge: {out or f"pkill exited {rc}"}'

    # rosapi backs roslib's topic/service lookups and is respawned by the same flag, so the
    # suite comes back together rather than leaving a rosapi bound to the old session. Its
    # absence is not fatal -- the websocket is what the dashboard actually needs.
    rc_api, out_api = _run(
        ['docker', 'exec', CONTAINER, 'pkill', '-INT', '-f', ROSAPI_PATTERN], timeout=15.0)
    if rc_api not in (0, 1):
        log.warning('could not signal rosapi_node: %s', out_api)

    if not _wait_for(lambda: _port_listening(ROSBRIDGE_PORT), ROSBRIDGE_TIMEOUT_S):
        return False, (f'rosbridge did not re-open port {ROSBRIDGE_PORT} within '
                       f'{ROSBRIDGE_TIMEOUT_S:g}s.')
    return True, 'rosbridge restarted.'


def _reboot_tmms_ws():
    """supervisorctl restart of the whole ROS container, then wait for it to come back."""
    rc, out = _sudo(['/usr/bin/supervisorctl', 'restart', SUPERVISOR_PROGRAM])
    if rc != 0:
        return False, f'supervisorctl restart failed: {out or f"exit {rc}"}'

    if not _wait_for(_container_running, TMMS_WS_TIMEOUT_S):
        return False, f'{CONTAINER} did not come back within {TMMS_WS_TIMEOUT_S:g}s.'

    # The container being up is not the same as the stack being usable -- rosbridge is the
    # last thing operation.launch.py brings up and the only part the dashboard talks to, so
    # its port is the honest readiness signal. Whatever budget the container did not spend is
    # left for it.
    if not _wait_for(lambda: _port_listening(ROSBRIDGE_PORT), ROSBRIDGE_TIMEOUT_S):
        return True, f'{CONTAINER} restarted, but rosbridge is not up yet.'
    return True, 'tmms_ws restarted.'


TARGETS = {
    'rosbridge': _reboot_rosbridge,
    'tmms_ws': _reboot_tmms_ws,
}


# ---------------------------------------------------------------------------------------
# job runner
# ---------------------------------------------------------------------------------------

def _worker(target):
    handler = TARGETS[target]
    try:
        ok, message = handler()
    except Exception as err:                     # noqa: BLE001 - a crashed worker must not
        log.exception('%s reboot raised', target)  # leave the job stuck on "running"
        ok, message = False, f'internal error: {err}'

    log.info('%s reboot finished: ok=%s %s', target, ok, message)
    with _lock:
        _job.update(state='done' if ok else 'failed', message=message,
                    finished=time.time())


def _start_job(target):
    """Returns (accepted, message). Rejects if a job is already in flight."""
    global _job
    with _lock:
        if _job is not None and _job['state'] == 'running':
            return False, f'a {_job["target"]} reboot is already running.'
        _job = {
            'target': target,
            'state': 'running',
            'message': f'restarting {target}...',
            'started': time.time(),
            'finished': None,
        }

    log.info('%s reboot requested', target)
    threading.Thread(target=_worker, args=(target,), daemon=True).start()
    return True, f'restarting {target}...'


# ---------------------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------------------

@app.get('/health')
def health():
    return jsonify(status='ok')


def _probe():
    """Environment snapshot for /status, cached briefly.

    The dashboard polls /status about once a second for the length of a restart, and each
    uncached call spawns `docker inspect` plus a `sudo supervisorctl` (a full PAM auth). The
    cache keeps a minute-long tmms_ws reboot to a handful of those instead of a hundred, at
    the cost of the reported state trailing reality by at most PROBE_TTL_S. The job state,
    which is what the dashboard actually waits on, is never cached.
    """
    global _probe_cache
    now = time.monotonic()
    cached = _probe_cache
    if cached and now - cached[0] < PROBE_TTL_S:
        return cached[1]

    # supervisorctl status exits non-zero when the program is merely stopped, so the exit
    # code is discarded; the state word in the output is what carries the answer. Format is
    # "quadruped:tmms_ws   RUNNING   pid 1234, uptime 0:05:00".
    _, out = _sudo(['/usr/bin/supervisorctl', 'status', SUPERVISOR_PROGRAM], timeout=20.0)
    parts = out.split()

    snapshot = {
        'rosbridge': {'listening': _port_listening(ROSBRIDGE_PORT)},
        'tmms_ws': {
            'container': 'running' if _container_running() else 'absent',
            'supervisor': parts[1] if len(parts) > 1 else 'unknown',
        },
    }
    _probe_cache = (now, snapshot)
    return snapshot


@app.get('/status')
def status():
    with _lock:
        job = dict(_job) if _job else None

    return jsonify(**_probe(), job=job)


@app.post('/reboot/<target>')
def reboot(target):
    if target not in TARGETS:
        return jsonify(error=f'unknown reboot target: {target}'), 404

    accepted, message = _start_job(target)
    if not accepted:
        return jsonify(accepted=False, error=message), 409
    return jsonify(accepted=True, message=message), 202


if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] %(levelname)s %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )
    log.info('reboot manager listening on 127.0.0.1:%d (container=%s, program=%s)',
             PORT, CONTAINER, SUPERVISOR_PROGRAM)
    # Loopback only: ui_backend.js proxies to it from the same host.
    app.run(host='127.0.0.1', port=PORT, threaded=True)
