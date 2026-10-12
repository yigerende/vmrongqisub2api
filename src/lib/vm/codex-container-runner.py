"""PID 1 for a single managed Codex account; no Docker access in the guest."""
import json
import os
import signal
import subprocess
import time

ROOT = '/slot'
child = None
quitting = False


def shutdown(*_):
    global quitting
    quitting = True


def stop():
    global child
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    child = None


def publish(value):
    target = ROOT + '/run/container-state.json'
    with open(target + '.tmp', 'w') as out:
        json.dump(value, out)
    os.replace(target + '.tmp', target)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
revision = None
failed = False
while not quitting:
    try:
        with open(ROOT + '/run/container-control.json') as source:
            control = json.load(source)
        if control['revision'] != revision:
            stop()
            revision = control['revision']
            failed = False
            if control.get('enabled'):
                socket = ROOT + '/run/codex-kernel.sock'
                if os.path.exists(socket):
                    os.unlink(socket)
                child = subprocess.Popen([ROOT + '/bin/kin-codex-kernel', ROOT + '/run/codex-kernel.json'],
                                         env={k: v for k, v in os.environ.items()
                                              if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')},
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if child is not None and child.poll() is not None:
            failed = True
        publish({'revision': revision, 'running': child is not None and child.poll() is None,
                 'pid': child.pid if child is not None else None, 'failed': failed, 'observed_at': time.time()})
    except Exception as error:
        publish({'revision': revision, 'running': False, 'failed': True, 'error': type(error).__name__})
    time.sleep(0.1)
stop()
publish({'revision': revision, 'running': False, 'stopped': True})
