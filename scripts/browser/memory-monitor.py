"""Sample native browser process RSS on macOS; no page automation or heap injection.

Usage: python3 scripts/browser/memory-monitor.py /tmp/browser-memory.jsonl
Stop with Ctrl-C after running the browser workload in fresh tabs.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

output = Path(sys.argv[1])
try:
    while True:
        processes = []
        lines = subprocess.check_output(['ps', '-axo', 'pid,ppid,rss,comm'], text=True)
        for line in lines.splitlines()[1:]:
            parts = line.strip().split(None, 3)
            if len(parts) != 4:
                continue
            pid, parent, rss, name = parts
            kind = None
            if 'com.apple.WebKit.WebContent' in name:
                kind = 'safari-content'
            elif 'Google Chrome Helper (Renderer)' in name:
                kind = 'chrome-content'
            elif 'com.apple.WebKit.GPU' in name:
                kind = 'safari-gpu'
            if kind:
                processes.append({'pid': int(pid), 'ppid': int(parent), 'rssKiB': int(rss), 'kind': kind})
        with output.open('a') as stream:
            stream.write(json.dumps({'time': time.time(), 'processes': processes}) + '\n')
        time.sleep(1)
except KeyboardInterrupt:
    pass
